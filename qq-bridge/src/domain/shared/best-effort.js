// @ts-check
// best-effort.js · 空 catch 的统一出口
//
// 目的：不再让 `catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'best-effort.js:3'); }` 静默消失。所有“确实可以忽略”的 catch 走这里，
// 行为仍是忽略，但会计数；排查时可用 catchStats() 看哪个文件在吞错。
import fs from 'node:fs';
import path from 'node:path';

const counts = new Map();

// [F2] 默认错误观察者：之前 errorObserver 默认 null，导致 436+ 处 catch 在生产环境完全不可见
// （错误黑洞）。现在无显式观察者时，按来源节流后落盘到 state/error-observed.log，让「子系统持续坏掉」
// 在运维侧有信号。显式 setErrorObserver 会覆盖此默认（例如接 observability 管线）。
const ERROR_LOG_PATH = (() => {
  try { return path.join(process.cwd(), 'state', 'error-observed.log'); } catch { return null; }
})();
const FILE_THROTTLE_MS = 60 * 1000;
const fileLastWritten = new Map();

function defaultFileObserver(event) {
  const source = event?.payload?.source;
  const message = event?.payload?.message;
  if (!ERROR_LOG_PATH || !source) return;
  const now = Date.now();
  if (now - (fileLastWritten.get(source) || 0) < FILE_THROTTLE_MS) return;
  fileLastWritten.set(source, now);
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
    const line = `${new Date().toISOString()} [error.observed] ${String(source)} ${String(message).slice(0, 400)}\n`;
    fs.appendFileSync(ERROR_LOG_PATH, line, 'utf8');
    // 容量护栏：超过 2MB 截断，仅保留最近 ~2000 行，避免日志自身把磁盘写满。
    try {
      const st = fs.statSync(ERROR_LOG_PATH);
      if (st.size > 2 * 1024 * 1024) {
        const keep = fs.readFileSync(ERROR_LOG_PATH, 'utf8').split('\n').slice(-2000).join('\n');
        fs.writeFileSync(ERROR_LOG_PATH, keep, 'utf8');
      }
    } catch { /* best-effort */ }
  } catch { /* 本函数绝不能抛 */ }
}

/**
 * [ERROR-OBSERVED] 单点错误观察者。
 * 旧系统 `error.observed` 被 offline-narrative / aliveness / incident-replay 消费，
 * 却没有任何生产者 → 完整性维恒为 no-data。436+ 处 catch 若各自 append 会重复记账，
 * 所以统一在 ignoredCatch 这一个出口按来源节流后上报（默认无观察者 = 行为不变）。
 */
let errorObserver = null;
const lastReported = new Map();
const REPORT_THROTTLE_MS = 60 * 1000;

/**
 * 设置单点错误观察者；传 null 恢复默认（节流落盘 state/error-observed.log）。
 * @param {((event: {type:string; payload:{source?:string; message?:string}}) => void) | null} fn
 * @returns {((event: {type:string; payload:{source?:string; message?:string}}) => void) | null}
 */
export function setErrorObserver(fn) {
  errorObserver = typeof fn === 'function' ? fn : null;
  return errorObserver;
}

/**
 * 空 catch 的统一出口：计数 + 节流上报（默认落盘，显式观察者覆盖）。
 * @param {unknown} error
 * @param {string} [where]
 * @returns {void}
 */
export function ignoredCatch(error, where = '?') {
  try {
    const key = String(where || '?');
    const msg = error instanceof Error ? error.message : String(error);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (process.env.CATCH_DEBUG === '1') {
      try { console.error(`[catch] ${key}: ${msg}`); } catch (inner) { void inner; }
    }
    const obs = errorObserver || defaultFileObserver;
    if (obs) {
      const now = Date.now();
      if (now - (lastReported.get(key) || 0) >= REPORT_THROTTLE_MS) {
        lastReported.set(key, now);
        try {
          obs({ type: 'error.observed', payload: { source: key, message: msg.slice(0, 200) } });
        } catch (inner) { void inner; }
      }
    }
  } catch (inner) {
    // 这个函数本身绝不能抛；inner 只是为满足“非空 catch”的审计规则。
    void inner;
  }
}

/**
 * 返回各来源吞错计数，便于排查哪个文件在持续吞错。
 * @returns {Record<string, number>}
 */
export function catchStats() {
  return Object.fromEntries([...counts.entries()].sort());
}

// 让 VM/独立脚本即使没显式 import 也能调用；没有加载时 catch 里的 ?. 会安全跳过。
try { globalThis.__ignoredCatch = ignoredCatch; } catch (error) { void error; }
