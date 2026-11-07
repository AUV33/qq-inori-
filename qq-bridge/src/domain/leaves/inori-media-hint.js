// inori-media-hint.js · 图片「看了可以记」提示（纯函数，零依赖）
//
// 现状断点：她看图片走 qq_get_message_images（视觉模型直接看图），
// 但看完的内容不进记忆——记忆/digest 里只剩 [图片] 占位符，
// 「之前那张图」这类指代就接不住。
//
// 这里只做一件事：当近期消息里有图时，递一句**事实+许可**
// （同黑话判定队列纪律：只说有什么、怎么用，看不看记不记全凭她），
// 空窗返回 null，不造暗示。

/**
 * @param {Array<{hasMedia?:boolean, media?:Array, text?:string, messageId?:any}>} recentMessages
 * @param {number} window 最近多少条消息内统计（默认 30）
 * @param {{key?: string}} [opts] key 是会话 key（group:xxx / private:xxx）；给了就能直接拼出可用的工具调用
 * @returns {string|null} 有图才返回提示行
 */
export function imageHintLine(recentMessages, window = 30, opts = {}) {
  const msgs = (Array.isArray(recentMessages) ? recentMessages : []).filter(Boolean);
  const withMedia = msgs
    .slice(-window)
    .filter((m) => m.hasMedia === true || (Array.isArray(m.media) && m.media.length > 0) || String(m.text ?? '').includes('[图片]'));
  const n = withMedia.length;
  if (!n) return null;
  // [EYE-1] 只说「有图」不够：她 2026-10-29 一晚上 0 次调用看图工具。把最新那张的 messageId
  // 和 key 直接写进提示，让她看一眼就知道该怎么调（仍然是事实+许可，看不看随她）。
  const latest = [...withMedia].reverse().find((m) => m && (m.messageId ?? m.id ?? m.seq) != null);
  const mid = latest ? (latest.messageId ?? latest.id ?? latest.seq) : null;
  const key = opts && typeof opts.key === 'string' ? opts.key.trim() : '';
  const how = mid != null
    ? `想看就用 qq_get_message_images(${key ? `key="${key}", ` : ''}messageId="${String(mid)}")`
    : '想看就用 qq_get_message_images 带上那条消息的 messageId';
  return `最近的消息里有 ${n} 张图：${how}——图里写了什么、画的是什么，得你自己看；不看的话就只剩 [图片] 占位。看了有想留一句的，qq_memory_append 记一条（theme 写那张图，一两句就行）；看不看随你。`;
}
