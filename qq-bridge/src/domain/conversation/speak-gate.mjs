// speak-gate.mjs · 「什么时候开口」的纯判定
//
// 背景：以前用「等安静」来实现「别抢话」——收到消息后强制等 10 秒（甚至更久）。
// 代价是她永远排在别人后面，节奏上就是个接话者。这里换成两个东西：
//   1) 防抖（debounce）：只为合并「对方还在连发」的那几秒，默认 2 秒；
//   2) 门闩（gate）：该不该说由 有没有人冲她 / 忙不忙 / 手上有没有自己的事 决定，不等安静。
//
// 纯函数、零 IO，方便单测（bridge 里的实现只负责把参数喂进来）。

/** 默认防抖：收到新消息后最多等这么久，用来把连发的几条合并成一次回复 */
export const REPLY_DEBOUNCE_MS = 2000;

/**
 * 首回复应等多久（防抖），以及还剩多久。
 * @param {object} input { now, lastIncomingAt, debounceMs }
 */
export function computeReplyTiming({ now = Date.now(), lastIncomingAt = 0, debounceMs = REPLY_DEBOUNCE_MS } = {}) {
  const quietMs = Math.max(0, Number(debounceMs) || 0);
  const value = Number(lastIncomingAt);
  const hasIncoming = Number.isFinite(value) && value > 0;
  const elapsed = hasIncoming ? Math.max(0, now - value) : 0;
  return {
    purpose: 'reply',
    quietMs,
    // 没有来信（或时间戳坏了）就没有「还在连发」这回事，不必等
    remainingQuietMs: hasIncoming ? Math.max(0, quietMs - elapsed) : 0,
  };
}

/**
 * 该不该现在开口。
 *
 * 优先级（先说为什么，再说等不等）：
 * - 有人明确冲她说（@/点名/问她/在聊她）→ 直接说，不等；
 * - 她手上有自己的事想说（hasOwnAgenda，等 A1 日程接入后才有真实值）→ 直接说，不等；
 * - 正忙（上一回合还没结束）→ 不说，也不排队；
 * - 其余（比如群里聊得热闹但没点她）→ 等防抖窗口过去再说，避免连发时插一句。
 *
 * @returns {{ speak: boolean, reason: string, waitMs: number }}
 */
export function evaluateSpeakGate({
  directed = false,
  busy = false,
  hasOwnAgenda = false,
  quietLeftMs = 0,
} = {}) {
  const left = Math.max(0, Number(quietLeftMs) || 0);
  if (busy) return { speak: false, reason: '上一回合还没结束', waitMs: 0 };
  if (directed) return { speak: true, reason: '有人冲你说话', waitMs: 0 };
  if (hasOwnAgenda) return { speak: true, reason: '你手上正好有想说的', waitMs: 0 };
  if (left > 0) return { speak: false, reason: '对方可能还在连发，等这几秒', waitMs: left };
  return { speak: true, reason: '没有人在连发', waitMs: 0 };
}
