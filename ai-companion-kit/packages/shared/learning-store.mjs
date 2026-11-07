// learning-store.mjs · 学习产物的唯一写入口（原子写 + 单写入者 + 趋势留痕）
//
// 为什么必须有这一层（2026-10-23 的真实事故）：
//   桥接用 appendFileSync 往 memory-group_*.jsonl 追加摘要，
//   同时隔壁会话的一次性脚本「备份 → 原地重写」把文件写成 0 字节，摘要丢了。
//   两个进程写同一个文件、没有锁、没有原子写 —— 必然丢数据。
//
// 规则：
//   1) 追加用 appendFileSync（单行小写入在 NTFS 上原子）
//   2) 整体重写必须 tmp → rename（rename 是原子的，不会出现「半截文件」）
//   3) 拿不到锁就短暂等待（≤100ms）后放弃并记 trend（不阻塞主流程）
//      [LOCK-NONBLOCK] 这层跑在 Node 主线程上，同步等待会卡住事件循环。早先上限是 3 秒，
//      锁争用时心跳/HTTP/定时器全被饿死，桥接表现为「进程活着但假死」。宁可丢这一次
//      写入（下一次保存会重试），也不让主线程停住。
//   4) 每次写入都追加一条 trend，便于事后核对「谁在什么时候写了什么」
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './inori-paths.mjs';

// 每次调用时读环境变量：测试和换目录都能生效（写死成 const 会导致测试设了 env 也不生效）
function trendPath() {
  return process.env.LEARNING_TREND || statePath('learning-trend.jsonl');
}
const LOCK_TIMEOUT_MS = 100;
const LOCK_STALE_MS = 30000;

// [RENAME-RETRY] Windows 上杀软/索引器会临时占用目标文件，裸 renameSync 抛 EPERM/EBUSY，
// 写盘直接失败（调用方多半还没看返回值）。与 qq-bridge/src/bootstrap/fs-utils.mjs 的
// renameWithRetry 同一策略；这里内联一份是因为 ai-companion-kit 是独立可发布的包，
// 不能反向依赖 qq-bridge。
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

function renameWithRetry(tmp, file, attempts = 4) {
  for (let i = 0; ; i += 1) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      const code = String(e?.code ?? '');
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || i >= attempts) throw e;
      sleepSync(40 * (i + 1));
    }
  }
}

export function trend(event) {
  try {
    const f = trendPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const row = { at: new Date().toISOString(), ...event };
    fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 趋势记不了不影响业务 */ }
}

// 锁文件名必须由绝对路径推导：同一个文件用相对/绝对两种写法会得到两个 <file>.lock，
// 同进程的 held 重入判断会失效（自锁到超时）。
function lockPath(file) { return `${path.resolve(file)}.lock`; }

// 同进程可重入：持锁者对同一文件再 acquire（如 withFileLock 内调 writeJsonDocument）
// 直接嵌套计数，不再走文件等待——否则自旋到超时，锁形同虚设。
// 跨进程的互斥仍由 <file>.lock 的 EEXIST 判定保证（进程内 Map 对其它进程不可见）。
const held = new Map(); // lockPath -> 本进程嵌套持有次数

function acquire(file) {
  const lk = lockPath(file);
  if (held.get(lk)) { held.set(lk, held.get(lk) + 1); return lk; }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lk, `${process.pid} ${Date.now()}`, { flag: 'wx' });
      held.set(lk, 1);
      return lk;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;      // 目录不存在等 → 交给调用方处理
      // 陈旧锁：持锁进程已死 / 超过 30 秒，直接清掉
      try {
        const [pid, ts] = fs.readFileSync(lk, 'utf8').split(' ');
        const stale = Date.now() - Number(ts) > LOCK_STALE_MS;
        // EPERM = 进程活着但没权限发信号（受保护进程），不能当成「已死」去偷锁。
        let alive = true;
        try { process.kill(Number(pid), 0); } catch (e) { alive = e?.code === 'EPERM'; }
        if (stale || !alive) { fs.rmSync(lk, { force: true }); continue; }
      } catch { /* 读不出就当陈旧 */ try { fs.rmSync(lk, { force: true }); } catch { /* ignore */ } continue; }
      if (Date.now() > deadline) return null;
      // 同步 API 下没法真正让出事件循环；至少不要 100% 占 CPU 空转（Atomics.wait 阻塞但睡眠）。
      sleepSync(25);
    }
  }
}

function release(lk) {
  if (!lk) return;
  const c = (held.get(lk) || 1) - 1;
  if (c > 0) { held.set(lk, c); return; } // 还有内层持有，锁文件留着
  held.delete(lk);
  try { fs.rmSync(lk, { force: true }); } catch { /* ignore */ }
}

/**
 * 追加一行 JSONL。
 *
 * [HALF-LINE] 崩溃可能在文件末尾留下没有换行的半行；直接 append 会把新记录粘在半行后面，
 * 于是新记录变成一条坏 JSON —— append 返回 ok、state 只报 corrupt，数据静默丢失。
 * 所以在同一把锁内先检查末字节：不是 \n 就先补一个换行（半行保留为 corrupt 证据），
 * 再追加新行；小文件追加后读回 parse 最后一行，验证失败返回 ok:false。
 *
 * fsync 默认关（高频写入不必每次落盘）；账本类调用方传 fsync:true。
 */
export function appendJsonl(file, obj, { source = '?', fsync = false } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lk = acquire(file);
    if (!lk) {
      trend({ op: 'append-skipped-lock', file: path.basename(file), source });
      return { ok: false, error: '学习数据文件锁等待超时' };
    }
    try {
      const line = JSON.stringify(obj) + '\n';
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      let needsNewline = false;
      if (size > 0) {
        const readFd = fs.openSync(file, 'r');
        try {
          const last = Buffer.alloc(1);
          fs.readSync(readFd, last, 0, 1, size - 1);
          needsNewline = last[0] !== 0x0a;
        } finally { fs.closeSync(readFd); }
      }
      const fd = fs.openSync(file, 'a');
      try {
        if (needsNewline) fs.writeSync(fd, '\n');
        fs.writeSync(fd, line, null, 'utf8');
        if (fsync) fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      // 读回校验只对小账本做（≤1MB），避免大日志每次追加都全量读。
      if (fs.statSync(file).size <= 1024 * 1024) {
        const text = fs.readFileSync(file, 'utf8');
        const lastLine = text.slice(0, -1).split('\n').pop();
        JSON.parse(lastLine);
      }
    } finally {
      release(lk);
    }
    trend({ op: 'append', file: path.basename(file), source, bytes: JSON.stringify(obj).length });
    return { ok: true };
  } catch (e) {
    trend({ op: 'append-failed', file: path.basename(file), source, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 整体重写（tmp → rename，原子） */
export function rewriteJsonl(file, rows, { source = '?' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lk = acquire(file);
  if (!lk) {
    trend({ op: 'rewrite-skipped-lock', file: path.basename(file), source });
    return { ok: false, error: '学习数据文件锁等待超时' };
  }
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const body = (rows ?? []).map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
    renameWithRetry(tmp, file);
    trend({ op: 'rewrite', file: path.basename(file), source, rows: (rows ?? []).length });
    return { ok: true };
  } catch (e) {
    trend({ op: 'rewrite-failed', file: path.basename(file), source, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    release(lk);
  }
}

/** 整体重写 JSON */
export function writeJson(file, obj, { source = '?' } = {}) {
  return rewriteJsonl(file, [obj], { source });
}

/** 原子写入普通 JSON 文档（目标文件不是 JSONL 时使用）。 */
export function writeJsonDocument(file, value, { source = '?' } = {}) {
  let lk = null;
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lk = acquire(file);
    if (!lk) {
      trend({ op: 'write-skipped-lock', file: path.basename(file), source });
      return { ok: false, error: '学习数据文件锁等待超时' };
    }
    tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameWithRetry(tmp, file);
    trend({ op: 'write', file: path.basename(file), source });
    return { ok: true };
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    trend({ op: 'write-failed', file: path.basename(file), source, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    release(lk);
  }
}

/** 读 JSONL（坏行跳过） */
export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * 锁内执行读-改-写（跨进程 RMW 原子性）。
 * fn() 在持锁期间**同步**执行一次，其返回值原样返回；拿不到锁返回 { ok: false, error }。
 * 2026-10-25 审计新增：tool-whitelist.json 等文件被桥接进程与 DSH 侧 MCP 进程
 * 交叉 读-改-写，裸 read-modify-write 在两进程并发时会互丢更新。
 */
export function withFileLock(file, fn, { source = '?' } = {}) {
  let lk = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lk = acquire(file);
    if (!lk) {
      trend({ op: 'lock-wait-timeout', file: path.basename(file), source });
      return { ok: false, error: '学习数据文件锁等待超时' };
    }
    return fn();
  } catch (e) {
    trend({ op: 'lock-failed', file: path.basename(file), source, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    if (lk) release(lk);
  }
}

/** 原子写任意文本（tmp → rename），带文件锁。writeJsonDocument 的文本版。 */
export function writeTextAtomic(file, text, { source = '?' } = {}) {
  let lk = null;
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lk = acquire(file);
    if (!lk) {
      trend({ op: 'text-write-skipped-lock', file: path.basename(file), source });
      return { ok: false, error: '学习数据文件锁等待超时' };
    }
    tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, String(text), 'utf8');
    renameWithRetry(tmp, file);
    trend({ op: 'text-write', file: path.basename(file), source, bytes: Buffer.byteLength(String(text), 'utf8') });
    return { ok: true };
  } catch (e) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    trend({ op: 'text-write-failed', file: path.basename(file), source, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    if (lk) release(lk);
  }
}
