// 会话未读水位：读消息 → 记录“模型看过哪些 seq” → 回复后自动确认。
//
// 从 app.mjs 的 main() 搬出（P3-RW-2，2026-10-31）。这组函数只读写一个 social-v2 状态对象，
// 不改 QQ/DSH，不持有定时器；搬出来后可用假 st 单测水位推进与引用回复的“只确认到被引用那条”。
//
// 纪律：状态仍由调用方持有（getSocialV2State / saveSocialV2State），本模块不缓存 st。
/**
 * @param {object} deps
 * @param {(key:string)=>object} deps.getSocialV2State
 * @param {()=>void} deps.saveSocialV2State
 * @param {(...args:any[])=>void} deps.log
 */
export function createUnreadState({ getSocialV2State, saveSocialV2State, log }) {
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    // 严格校验是安全契约：没展示给模型的 seq 不能确认已读（否则会吞掉别人的消息）。
    // [ROTATE-KEEP-SEEN] 真正让水位莫名回退的是轮换清空 modelSeenSeqs，已在 retireSession 修掉。
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error(`throughSeq 必须是不超过已展示连续消息水位的非负安全整数；当前可用 readThroughSeq=${max}（lastUnreadSeq=${st.lastUnreadSeq}）。请用这个值再试，或先读一次未读消息。正确调用：qq_mark_read({ key: 你这次用的 key, token, throughSeq: ${max} })——不要传你看到的最大 seq（${st.lastUnreadSeq}），那会越过水位被拒。`);
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // [AUTO-ACK] 她说完话 → 自动确认这次唤醒里看过的那段未读。
  // 以前不 ack：同一段未读在每次唤醒里反复注入，她就会对着同样的输入重复输出（「知道了」说好几遍）。
  // [ACK-QUOTE] 她引用了较早的消息时，只确认到被引用那条；更新的未读留给下一轮，避免“回了旧的、新的被静默已读”
  function ackCeilForReply(key, messageId) {
    if (!messageId) return 0;
    try {
      const st = getSocialV2State(key);
      const target = [...(st.unread || []), ...(st.recentMessages || [])]
        .find((m) => String(m?.messageId ?? '') === String(messageId));
      const seq = Number(target?.seq);
      return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
    } catch { return 0; }
  }
  function autoAckAfterSend(key, ceilingSeq = 0) {
    try {
      const st = getSocialV2State(key);
      const pending = Number(st.pendingAckSeq) || 0;
      const seq = ceilingSeq > 0 && pending ? Math.min(pending, ceilingSeq) : pending;
      if (!seq) return 0;
      const marked = acknowledgeMessagesV2(st, seq);
      st.pendingAckSeq = 0;
      if (marked) {
        saveSocialV2State();
        log(`[auto-ack] ${key} 说完话自动确认 ${marked} 条已读（through=${seq}${ceilingSeq > 0 && pending > seq ? `；引用较早消息，晚于它的未读留到下轮` : ''}）`);
      }
      return marked;
    } catch (error) {
      log(`[auto-ack] ${key} 自动确认失败（忽略）: ${error?.message ?? error}`);
      return 0;
    }
  }


  return {
    readThroughSeqV2,
    noteModelMessagesV2,
    requestedReadThroughSeqV2,
    acknowledgeMessagesV2,
    ackCeilForReply,
    autoAckAfterSend,
  };
}
