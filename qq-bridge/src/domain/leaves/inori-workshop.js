// inori-workshop.js · 她的工坊（workshop）：给自己写小工具/小游戏的个人空间
// 安全边界（硬约束）：
//   - 只允许在 WORKSHOP_DIR（默认 data/workshop）内读写文件；
//   - 沙箱：无 require / import / process / 网络（无 fetch/http/net/dgram）/ 子进程 / 全局覆盖；
//   - 执行超时（默认 10s）、输出截断（默认 4KB）；
//   - 沙箱内可用的：纯 JS + 一组受控 API（safeRead/safeWrite/safeList/safeDelete，路径被校验必须落在 WORKSHOP_DIR 内）；
//   - 沙箱内不可见的：bridge 配置、state 目录、QQ 凭据——一律读不到。
// 纯模块（沙箱执行用 node:vm，无 IO 副作用，IO 通过受控 API 注入）。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { projectPath } from '../shared/project-paths.js';

export const WORKSHOP_DIR = projectPath('data', 'workshop');
const TIMEOUT_MS = 10000;
const OUTPUT_CAP = 4096;

/** 校验路径必须落在 WORKSHOP_DIR 内（防 ../ 逃逸）。返回绝对路径；越界返回 null。 */
export function safeResolve(p) {
  if (!p || typeof p !== 'string') return null;
  let abs = path.resolve(WORKSHOP_DIR, p);
  const root = path.resolve(WORKSHOP_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** 列工坊目录（只列文件，相对路径 + 大小 + 修改时间） */
export function listWorkshop() {
  ensureWorkshop();
  try {
    return fs.readdirSync(WORKSHOP_DIR)
      .filter((n) => !n.startsWith('.'))
      .map((n) => {
        try {
          const st = fs.statSync(path.join(WORKSHOP_DIR, n));
          return { name: n, size: st.size, mtime: st.mtime.toISOString() };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch { return []; }
}

/** 读工坊内文件（文本）。越界/不存在 → 返回 { ok:false }。 */
export function readWorkshop(rel) {
  const abs = safeResolve(rel);
  if (!abs) return { ok: false, error: '路径越界（只能读工坊目录内）' };
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { ok: true, text: text.slice(0, 8000) };
  } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

/** 写工坊内文件（整份覆盖或追加）。 */
export function writeWorkshop(rel, text, append = false) {
  const abs = safeResolve(rel);
  if (!abs) return { ok: false, error: '路径越界（只能写工坊目录内）' };
  ensureWorkshop();
  try {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // [TOCTOU-FIX] appendFileSync 本身会创建缺失文件；先 existsSync 再 append/write 是竞态窗口。
    if (append) fs.appendFileSync(abs, text, 'utf8');
    else fs.writeFileSync(abs, text, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(text) };
  } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

/** 删除工坊内文件 */
export function deleteWorkshop(rel) {
  const abs = safeResolve(rel);
  if (!abs || abs === path.resolve(WORKSHOP_DIR)) return { ok: false, error: '路径越界' };
  try {
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

function ensureWorkshop() {
  try {
    if (!fs.existsSync(WORKSHOP_DIR)) fs.mkdirSync(WORKSHOP_DIR, { recursive: true });
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-workshop.js:83'); }
}

/**
 * 在沙箱里跑一段脚本（她的"给自己写的工具/游戏"）。
 * 独立 worker 线程执行（vm 上下文）+ 主线程看门狗 terminate → 真超时可打断。
 * 沙箱 API 注入：console/print（收集到 output）、safeRead/safeWrite/safeList/safeDelete（工坊内文件）。
 * 危险全局一律不给：require / import / process / 网络 / 子进程。
 * 代码包成 async IIFE → 顶层 return 合法，async 脚本也能 await。
 */
export function runScript(code, { timeoutMs = TIMEOUT_MS, outputCap = OUTPUT_CAP } = {}) {
  ensureWorkshop();
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: '没有代码' };
  const worker = new Worker(new URL('./inori-workshop-worker.js', import.meta.url));
  let resolveRef;
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(wd);
    try { worker.terminate(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-workshop.js:103'); }
    resolveRef?.(payload);
  };
  const wd = setTimeout(() => {
    finish({ ok: false, output: '', error: `执行超时（看门狗 ${Math.round((timeoutMs + 2000) / 1000)}s）` });
  }, timeoutMs + 2000);
  wd.unref?.();
  return new Promise((resolve) => {
    resolveRef = resolve;
    worker.on('message', (msg) => {
      finish({
        ok: !!msg.ok,
        output: msg.output ?? '',
        result: msg.result || undefined,
        truncated: !!msg.trunc,
        error: msg.error || (msg.ok ? undefined : '执行失败'),
      });
    });
    worker.on('error', (e) => {
      finish({ ok: false, output: '', error: `worker 异常: ${e?.message ?? e}` });
    });
    worker.on('exit', () => {
      finish({ ok: false, output: '', error: 'worker 提前退出（无结果）' });
    });
    worker.postMessage({ code, timeoutMs, outputCap });
  });
}
function fmt(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  if (v === null) return 'null';
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
}
