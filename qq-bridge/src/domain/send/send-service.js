// send-service.js · 发送额度的纯函数（从 console-server 三处重复逻辑抽出）
//
// 只负责 sendTimes 的 check / reserve / rollback，不碰网络、不碰 bot。
// 行为与原实现保持一致：预占 N 条；失败只回滚未发出的条数；最多保留 500 条。

/**
 * 兼容模型把 messages 传成 JSON 字符串 / 单条字符串；返回统一数组。
 * 这段解析原来在 send-burst / send-message 两个路由里各写了一遍。
 */
export function normalizeSendMessages(rawMessages) {
  let raw = rawMessages;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed.map(String);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.js:18'); }
    } else if (trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') raw = parsed;
        else if (Array.isArray(parsed)) raw = parsed.map(String);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.js:24'); }
    }
  }
  const isRawString = typeof raw === 'string';
  const messages = Array.isArray(raw)
    ? raw.map((m) => String(m ?? '').trim()).filter(Boolean)
    : (isRawString ? [String(raw).trim()].filter(Boolean) : []);
  return { messages, isRawString };
}

/**
 * 发送前的消息形状检查：条数 / 单条字数 / 敏感信息。
 * 返回 {ok,status,error}，由路由决定怎么回 HTTP；保持原有状态码。
 */
export function validateMessageBounds(messages, { maxMsgs = 8, maxChars = 500, sensitiveRe = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, status: 400, error: 'messages 不能为空' };
  if (messages.length > maxMsgs) return { ok: false, status: 400, error: `最多发送 ${maxMsgs} 条` };
  for (const msg of messages) {
    if (String(msg).length > maxChars) return { ok: false, status: 400, error: `单条消息不能超过 ${maxChars} 字` };
    if (sensitiveRe && sensitiveRe.test(String(msg))) return { ok: false, status: 403, error: '消息含敏感信息，已阻止发送' };
  }
  return { ok: true };
}

export function trimSendTimes(st, keep = 500) {
  if (!st || !Array.isArray(st.sendTimes)) return;
  if (st.sendTimes.length > keep) st.sendTimes = st.sendTimes.slice(-keep);
}

export function checkSendRate(st, now, { maxPerMinute = 0, maxPerHour = 0 } = {}, count = 1) {
  const times = Array.isArray(st?.sendTimes) ? st.sendTimes : [];
  const recentMinute = times.filter((t) => now - t < 60000).length;
  const recentHour = times.filter((t) => now - t < 3600000).length;
  const ok = !((maxPerMinute > 0 && recentMinute + count > maxPerMinute)
    || (maxPerHour > 0 && recentHour + count > maxPerHour));
  return { ok, recentMinute, recentHour };
}

export function reserveSendTimes(st, now, count = 1) {
  if (!st) return;
  if (!Array.isArray(st.sendTimes)) st.sendTimes = [];
  for (let i = 0; i < count; i++) st.sendTimes.push(now);
  trimSendTimes(st);
}

export function rollbackSendTimes(st, now, count = 1) {
  if (!st || !Array.isArray(st.sendTimes)) return;
  for (let i = 0; i < count; i++) {
    const idx = st.sendTimes.indexOf(now);
    if (idx >= 0) st.sendTimes.splice(idx, 1);
  }
  trimSendTimes(st);
}
