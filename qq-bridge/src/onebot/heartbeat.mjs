/**
 * OneBot 心跳看护：连接“看起来还开着”但已经收不到事件时，主动把它踢掉重连。
 *
 * 借鉴 dsh-onebot 的 armHeartbeat：
 *   - 只有真的收到过 meta_event/heartbeat 才开始计时（没心跳的实现不会被误杀）；
 *   - 阈值默认 120s；如果 OneBot 自己报的 interval 更大，按 interval×3 放宽；
 *   - 超时只回调一次，然后重置计时，避免每个 tick 都重连；
 *   - 连接已断开（SDK 正在重连）时跳过，不跟 SDK 抢。
 *
 * 纯逻辑 + 注入时钟/定时器：不直接依赖 ws，离线可测。
 */

const DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  checkIntervalMs: 30_000,
  // [FIRST-EVENT] 连上了却一个心跳/消息都没有：旧逻辑 `!seen` 直接 skipped，
  // SnowLuma 连着但没登录/事件推送静默停摆时，桥接永远不重连也不告警。
  firstEventTimeoutMs: 180_000,
});

export function createHeartbeatWatch(options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : DEFAULTS.timeoutMs;
  const checkIntervalMs = Number.isSafeInteger(options.checkIntervalMs) && options.checkIntervalMs > 0
    ? options.checkIntervalMs
    : DEFAULTS.checkIntervalMs;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const isConnected = typeof options.isConnected === 'function' ? options.isConnected : () => true;
  const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {};
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
  const firstEventTimeoutMs = Number.isSafeInteger(options.firstEventTimeoutMs) && options.firstEventTimeoutMs >= 0
    ? options.firstEventTimeoutMs
    : DEFAULTS.firstEventTimeoutMs;

  let seen = false;
  let lastHeartbeatAt = 0;
  let lastIntervalMs = 0;
  let openedAt = 0;          // 本次连接建立时刻；0 = 未知/未连接
  let lastActivityAt = 0;    // 本次连接上收到的最后一条任意事件
  let firstWindowFired = false;
  let timer = null;
  let timeouts = 0;
  let checks = 0;
  let lastResult = null;

  function effectiveTimeoutMs() {
    if (timeoutMs === 0) return 0;
    // OneBot 的 interval 单位是毫秒；比它慢三倍还没来才算死。
    return Math.max(timeoutMs, lastIntervalMs > 0 ? lastIntervalMs * 3 : 0);
  }

  function noteHeartbeat(intervalMs) {
    const iv = Number(intervalMs);
    if (Number.isFinite(iv) && iv > 0) lastIntervalMs = Math.round(iv);
    lastHeartbeatAt = now();
    seen = true;
  }

  /** 连接建立：开一个"首事件"观察窗（任何心跳/消息都算活）。 */
  function noteOpen(nowMs = now()) {
    openedAt = nowMs;
    lastActivityAt = 0;
    firstWindowFired = false;
  }

  /** 收到任意入站事件：证明这条连接不是死的（消息实现可以没有 heartbeat）。 */
  function noteActivity(nowMs = now()) {
    lastActivityAt = nowMs;
  }

  function reset() {
    seen = false;
    lastHeartbeatAt = 0;
    lastIntervalMs = 0;
    openedAt = 0;
    lastActivityAt = 0;
    firstWindowFired = false;
    lastResult = null;
  }

  function check(nowMs = now()) {
    checks += 1;
    if (timeoutMs === 0) {
      lastResult = { ok: true, skipped: 'disabled' };
      return lastResult;
    }
    if (!seen) {
      // 连上了、给了观察窗、期间一条事件都没有 → 连接是"开着但不通"，踢掉重连一次。
      if (firstEventTimeoutMs > 0 && openedAt > 0 && !firstWindowFired
        && nowMs - openedAt > firstEventTimeoutMs && lastActivityAt < openedAt) {
        firstWindowFired = true;
        timeouts += 1;
        lastResult = { ok: false, reason: 'no-first-event', ageMs: nowMs - openedAt, timeoutMs: firstEventTimeoutMs };
        try { onTimeout({ ...lastResult, at: nowMs }); } catch { /* 回调失败不打死看护 */ }
        return lastResult;
      }
      lastResult = { ok: true, skipped: 'no-heartbeat' };
      return lastResult;
    }
    if (!isConnected()) {
      lastResult = { ok: true, skipped: 'disconnected' };
      return lastResult;
    }

    const limit = effectiveTimeoutMs();
    const ageMs = nowMs - lastHeartbeatAt;
    if (ageMs > limit) {
      timeouts += 1;
      // 只报一次：把基准挪到当前时刻，给重连留出一个完整阈值。
      lastHeartbeatAt = nowMs;
      lastResult = { ok: false, reason: 'timeout', ageMs, timeoutMs: limit };
      try {
        onTimeout({ ...lastResult, at: nowMs });
      } catch {
        // 回调失败不应打死看护本身
      }
      return lastResult;
    }

    lastResult = { ok: true, ageMs, timeoutMs: limit };
    return lastResult;
  }

  function start() {
    if (timeoutMs === 0 || timer !== null) return;
    timer = setIntervalFn(() => check(), checkIntervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function stats() {
    return {
      seen,
      lastHeartbeatAt,
      lastIntervalMs,
      openedAt,
      firstEventTimeoutMs,
      effectiveTimeoutMs: effectiveTimeoutMs(),
      timeouts,
      checks,
      timerActive: timer !== null,
      lastResult,
    };
  }

  return { noteHeartbeat, noteOpen, noteActivity, reset, check, start, stop, stats };
}

export { DEFAULTS as HEARTBEAT_WATCH_DEFAULTS };
