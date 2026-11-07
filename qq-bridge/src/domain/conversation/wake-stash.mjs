// wake-stash.mjs · 唤醒理由暂存的单一实现（纯函数）。
//
// 干什么：会话繁忙/限流跳过时，把"该反应的来头"暂存进会话状态，去重 + 有界。
// 为什么：旧实现在 wake-sender.mjs 里写了两遍、在 wake-schedule.mjs 里又写一遍，
//         三份副本已经出现行为分叉（去重/上限/日志各改各的），是典型的"改一处漏两处"bug 源。
// 输入输出：stashWakeReason(st, reason) → {seq, added}；直接原地修改 st.pendingWakeReasons。
// 失败模式：st 非对象时安全返回 {seq:0, added:false}，绝不抛。
// 不做什么：不挂重试定时器、不写日志（各路径的兜底策略与日志口径不同，留给调用点）。

export const MAX_PENDING_WAKE_REASONS = 20;

export function stashWakeReason(st, reason) {
  if (!st || typeof st !== 'object') return { seq: 0, added: false };
  if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
  const seq = st.lastUnreadSeq || 0;
  if (st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
    return { seq, added: false };
  }
  st.pendingWakeReasons.push({ reason, seq });
  if (st.pendingWakeReasons.length > MAX_PENDING_WAKE_REASONS) {
    st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - MAX_PENDING_WAKE_REASONS);
  }
  return { seq, added: true };
}
