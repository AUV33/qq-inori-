// [P2-2] 资源门：内存/CPU 紧张时让低优先级后台让路（规划 §4 P2-2）。
//
// 设计纪律（来自规划原文）：
//  1. 阈值必须可配、可关；
//  2. 默认先「观察模式」（只记不打），跑 24 小时看日志再决定是否真的暂停；
//  3. 不新增常驻进程——采样用 os.cpus()/os.freemem()，一个 unref 的定时器，不 spawn 任何程序。
//
// CPU 口径：os.cpus() 的 times 是**自开机以来的累计值**，两次采样求差才是这段时间的占用率；
// 单次采样算不出 CPU，所以第一次采样记为 0，第二次起才有意义。
import os from 'node:os';

export const DEFAULT_LOW_KINDS = ['intake', 'slang', 'groupfact'];

/** `isolated:slang` / `task:ab12` → `slang` / `task`；用于把 label 归到 kind。 */
export function kindOfLabel(label) {
  return String(label ?? '')
    .replace(/^isolated:/, '')
    .replace(/[:#].*$/, '');
}

/** 抓一份 CPU 累计时间快照。 */
export function cpuSnapshot(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of Array.isArray(cpus) ? cpus : []) {
    const t = cpu?.times ?? {};
    idle += Number(t.idle) || 0;
    total += (Number(t.user) || 0) + (Number(t.nice) || 0) + (Number(t.sys) || 0)
      + (Number(t.idle) || 0) + (Number(t.irq) || 0);
  }
  return { idle, total };
}

/** 两次快照之间的系统 CPU 占用率（0–100，整数）。 */
export function cpuBusyPercent(prev, cur) {
  if (!prev || !cur) return 0;
  const dTotal = Number(cur.total) - Number(prev.total);
  const dIdle = Number(cur.idle) - Number(prev.idle);
  if (!(dTotal > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

/**
 * 建资源门。所有外部依赖可注入，便于单测。
 * @returns {{sample:Function, shouldHold:Function, state:Function, stop:Function}}
 */
export function createResourceGate({
  enabled = true,
  observeOnly = true,
  minFreeMemMB = 1536,
  maxCpuPercent = 80,
  lowKinds = DEFAULT_LOW_KINDS,
  sampleMs = 30000,
  log = () => {},
  memFree = () => os.freemem(),
  cpus = () => os.cpus(),
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (t) => clearInterval(t),
} = {}) {
  const lows = new Set((Array.isArray(lowKinds) ? lowKinds : []).map((k) => String(k)));
  const memLimit = Math.max(0, Number(minFreeMemMB) || 0);
  const cpuLimit = Math.max(0, Number(maxCpuPercent) || 0);
  let prevCpu = null;
  let state = { at: 0, freeMemMB: 0, cpuPercent: 0, memLow: false, cpuHigh: false, pressured: false };
  let logKey = null;

  function sample() {
    const ts = now();
    let freeMemMB = 0;
    try { freeMemMB = Math.round((Number(memFree()) || 0) / 1048576); } catch { freeMemMB = 0; }
    let cpuPercent = 0;
    try {
      const cur = cpuSnapshot(cpus());
      cpuPercent = cpuBusyPercent(prevCpu, cur);
      prevCpu = cur;
    } catch { cpuPercent = 0; }
    // 内存读不到（0）时不判内存：宁可漏一次，也不因读失败误停她的后台。
    const memLow = freeMemMB > 0 && freeMemMB < memLimit;
    const cpuHigh = cpuLimit > 0 && cpuPercent > cpuLimit;
    state = { at: ts, freeMemMB, cpuPercent, memLow, cpuHigh, pressured: memLow || cpuHigh };
    return state;
  }

  function reasonText() {
    return [
      state.memLow ? `空闲内存 ${state.freeMemMB}MB < ${memLimit}MB` : '',
      state.cpuHigh ? `CPU ${state.cpuPercent}% > ${cpuLimit}%` : '',
    ].filter(Boolean).join('，');
  }

  /**
   * 这条 waiter 本轮是否应当被挡下。
   * 观察模式返回 false（只记日志），真正启用后才返回 true。
   */
  function shouldHold(waiter) {
    if (!enabled) return false;
    const kind = waiter?.kind === 'chat' ? 'chat' : kindOfLabel(waiter?.label);
    if (!lows.has(kind)) return false;
    if (!state.pressured) { logKey = null; return false; }
    const reason = reasonText();
    if (!observeOnly) {
      if (logKey !== `hold:${reason}`) {
        logKey = `hold:${reason}`;
        log(`[resource-gate] ${reason}，暂停低优先级后台（${kind} 等）`);
      }
      return true;
    }
    if (logKey !== `obs:${reason}`) {
      logKey = `obs:${reason}`;
      log(`[resource-gate] 观察模式：${reason}，本应暂停 ${kind} 这类低优先级后台（只记不打）`);
    }
    return false;
  }

  sample();
  const timer = setTimer(() => {
    try { sample(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'resource-gate.js:118'); }
  }, Math.max(1000, Number(sampleMs) || 30000));
  timer?.unref?.();

  return {
    sample,
    shouldHold,
    state: () => ({ ...state, enabled, observeOnly, minFreeMemMB: memLimit, maxCpuPercent: cpuLimit, lowKinds: [...lows] }),
    stop: () => { try { clearTimer(timer); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'resource-gate.js:126'); } },
  };
}
