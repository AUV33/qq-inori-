// state-store.mjs · 单写者状态仓（原子写 + 进程内串行 + 可选文件锁）
//
// 干什么：给“她的事实”一个统一入口：路径安全、原子写、读容错、读改写串行、schema 校验。
// 为什么：状态散落且多写者（蓝图 G2）；裸 writeFileSync 会丢数据（CodeBuddy B1/B2）；测试还会污染真实状态。
// 输入输出：工厂返回 store；读写相对 root 的路径；JSON/JSONL。
// 失败模式：路径越界直接抛错；校验失败抛错且不写；读写异常向上抛（调用方决定降级）。
// 不做什么：不含业务语义、不决定 schema 内容、不做跨进程锁的实现（可注入 lock）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §5（数据契约）与 R0

import nodeFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, readJsonSafe, renameWithRetry } from '../../bootstrap/fs-utils.mjs';

export const STATE_STORE_VERSION = 1;

function assertSafeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('state-store: path required');
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) throw new Error('state-store: absolute path rejected: ' + rel);
  const normalized = rel.split('\\').join('/');
  if (normalized.split('/').includes('..')) throw new Error('state-store: path traversal rejected: ' + rel);
  return normalized;
}

function defaultNow() {
  return Date.now();
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* 容错：坏行跳过 */ }
  }
  return rows;
}

/**
 * @param {{root:string, fsImpl?:object, now?:()=>number, withLock?:(file:string, fn:Function)=>any}} opts
 */
export function createStateStore(opts = {}) {
  if (!opts.root || typeof opts.root !== 'string') throw new Error('state-store: root required');
  const root = path.resolve(opts.root);
  const io = opts.fsImpl || nodeFs;
  const now = typeof opts.now === 'function' ? opts.now : defaultNow;
  const withLock = typeof opts.withLock === 'function' ? opts.withLock : null;
  const queues = new Map();

  function resolve(rel) {
    const safe = assertSafeRel(rel);
    const full = path.resolve(root, safe);
    const relCheck = path.relative(root, full);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new Error('state-store: outside root: ' + rel);
    return full;
  }

  function enqueue(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/shared/state-store.mjs:62'));
    queues.set(key, tracked);
    // [F9] 结算后从队列 Map 移除自身，避免按文件路径为 key 的项永久堆积 → 内存泄漏。
    // 若期间有新任务入队，queues.get(key) 已不是 tracked，旧项不会被误删（串行链不断）。
    tracked.finally(() => { if (queues.get(key) === tracked) queues.delete(key); }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/shared/state-store.mjs:66'));
    return next;
  }

  function readJson(rel, fallback = undefined) {
    return readJsonSafe(resolve(rel), fallback, false);
  }

  // [AUDIT-FIX] 所有写路径都要经过同一把跨进程锁。
  // 以前只有 updateJson 用它，而生产里根本没有 .updateJson() 调用点，
  // state-hub 的 flush 与 groundwork 的落盘全走 writeJson → 注入的锁形同虚设。
  function callWithLock(file, run) {
    if (!withLock) return run();
    const result = withLock(file, run);
    // learning-store.withFileLock 拿不到锁/异常时返回 {ok:false,error} 而不是抛错，
    // 若不转换，调用方会把"一次都没写"当成成功，静默丢状态。
    if (result && typeof result === 'object' && result.ok === false && typeof result.error === 'string') {
      throw new Error(`state-store: 文件锁失败 ${path.basename(file)}: ${result.error}`);
    }
    return result;
  }

  function writeJson(rel, value, options = {}) {
    const file = resolve(rel);
    return enqueue(file, async () => callWithLock(file, () => {
      if (typeof options.validate === 'function') options.validate(value);
      atomicWriteJson(file, value);
      return file;
    }));
  }

  /**
   * 读-改-写：进程内按文件串行；若注入了 withLock，再加跨进程锁。
   * mutator(current) 返回新值；返回 undefined 表示不写。
   */
  function updateJson(rel, mutator, options = {}) {
    const file = resolve(rel);
    if (typeof mutator !== 'function') throw new Error('state-store: mutator required');
    return enqueue(file, async () => callWithLock(file, () => {
      const current = readJsonSafe(file, options.fallback === undefined ? null : options.fallback, false);
      const next = mutator(current);
      if (next === undefined) return current;
      if (typeof options.validate === 'function') options.validate(next);
      atomicWriteJson(file, next);
      return next;
    }));
  }

  function appendJsonl(rel, rows) {
    const file = resolve(rel);
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) return Promise.resolve(file);
    return enqueue(file, async () => {
      io.mkdirSync(path.dirname(file), { recursive: true });
      const text = list.map((row) => JSON.stringify(row)).join('\n') + '\n';
      io.appendFileSync(file, text, 'utf8');
      return file;
    });
  }

  function readJsonl(rel) {
    try {
      return parseJsonLines(io.readFileSync(resolve(rel), 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function exists(rel) {
    try { return io.existsSync(resolve(rel)); } catch { return false; }
  }

  function stat(rel) {
    try { return io.statSync(resolve(rel)); } catch { return null; }
  }

  function list(rel = '.', options = {}) {
    const dir = rel === '.' ? root : resolve(rel);
    try {
      return io.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => options.includeDirs === true || entry.isFile())
        .map((entry) => entry.name);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function remove(rel) {
    const file = resolve(rel);
    return enqueue(file, async () => {
      try { io.unlinkSync(file); return true; } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  function updateText(rel, fn) {
    const file = resolve(rel);
    return enqueue(file, async () => {
      const current = io.existsSync(file) ? io.readFileSync(file, 'utf8') : '';
      const next = fn(current);
      io.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      io.writeFileSync(tmp, next, 'utf8');
      renameWithRetry(tmp, file);
      return next;
    });
  }

  // [SCOPE] M2 会话作用域：返回带前缀的 store，所有读写自动落到 `<prefix>/...`。
  // 进程内串行队列的 key 与跨进程锁的文件路径都含前缀 → 不同作用域天然隔离
  // （互不排队、互不覆盖）。这是「每个对话/任务拿到独立命名空间、杜绝跨会话污染」的地基。
  function makeScoped(prefix) {
    const base = String(prefix || '');
    if (!base || base === '.') return api;
    const join = (rel) => {
      const r = String(rel ?? '');
      if (r === '' || r === '.') return base;
      return base + '/' + assertSafeRel(r);
    };
    return {
      v: STATE_STORE_VERSION,
      root,
      prefix: base,
      scope: (sub) => makeScoped(base + '/' + assertSafeRel(sub)),
      resolve: (rel) => resolve(join(rel)),
      readJson: (rel, fb) => readJson(join(rel), fb),
      writeJson: (rel, val, opt) => writeJson(join(rel), val, opt),
      updateJson: (rel, mut, opt) => updateJson(join(rel), mut, opt),
      appendJsonl: (rel, rows) => appendJsonl(join(rel), rows),
      readJsonl: (rel) => readJsonl(join(rel)),
      updateText: (rel, fn) => updateText(join(rel), fn),
      exists: (rel) => exists(join(rel)),
      stat: (rel) => stat(join(rel)),
      list: (rel = '.', opt) => list(rel === '.' || rel === '' ? '.' : join(rel), opt),
      remove: (rel) => remove(join(rel)),
      now,
    };
  }

  const api = {
    v: STATE_STORE_VERSION,
    root,
    scope: (prefix) => makeScoped(prefix),
    resolve,
    readJson,
    writeJson,
    updateJson,
    appendJsonl,
    readJsonl,
    updateText,
    exists,
    stat,
    list,
    remove,
    now,
  };
  return api;
}

export { parseJsonLines };
