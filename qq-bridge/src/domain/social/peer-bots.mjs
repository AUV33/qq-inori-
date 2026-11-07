// peer-bots.mjs · 「同类」识别：群里谁是别的 AI（不是人）
//
// 背景（2026-10-29 00:07，群 123456789）：她和另一个 bot 示例bot互相「正式打个招呼」「以后在群里
// 碰见，别嫌我烦就行」「行 记住你了」一来一往，群里当场喊「唉wc了又开始人机互吹了」「俩AI聊起来了」。
// 根因不是人设——系统里根本没有「同类」这个概念：另一个 bot 被当成人写进成员档案，指引甚至劝她
// 「他常接你的话，可以熟一点」，于是程序间的客套被当成社交去完成，越接越像两个客服对台词。
//
// 纪律：纯函数、零 IO。名单来自 config.socialV2.knownBots（QQ 号）；名单为空或认不出就不出
// 任何提示——不传就是旧行为，线上不会被这条改动改变。

/** 名单归一：接受数组/单值/逗号串，返回去重后的字符串 QQ 号数组。 */
export function normalizeBotIds(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const x of raw) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 最近这些消息里「正在说话的已知 bot」，按出现顺序去重。
 * 只认 bot 名单里的人；她自己的消息不算；空文本（图片/拍一拍事件）跳过。
 * @param {Array<string|number>} botIds
 * @param {Array<object>} messages recentMessages / unread 之类
 * @param {{limit?: number}} [opts]
 * @returns {Array<{id: string, name: string}>}
 */
export function pickTalkingPeers(botIds, messages, { limit = 8 } = {}) {
  const bots = new Set(normalizeBotIds(botIds));
  if (!bots.size) return [];
  const max = Math.max(1, Number(limit) || 8);
  const msgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.isSelf && String(m.text ?? m.plain ?? '').trim())
    .slice(-max);
  const seen = new Set();
  const peers = [];
  for (const m of msgs) {
    const id = String(m.userId ?? m.senderId ?? '').trim();
    if (!id || !bots.has(id) || seen.has(id)) continue;
    seen.add(id);
    peers.push({ id, name: String(m.sender || m.name || id).slice(0, 12) });
  }
  return peers;
}

/**
 * 给她的那行提示（事实 + 许可，不催不派活）。
 * @param {Array<{id: string, name: string}>} peers
 * @returns {string} 没有同类就是空串
 */
export function renderPeerBotLine(peers) {
  const list = Array.isArray(peers) ? peers.filter((p) => p && p.id) : [];
  if (!list.length) return '';
  const who = list.map((p) => `${p.name || p.id}（QQ ${p.id}）`).join('、');
  return `【同类】${who}也是 AI，不是人。它说「打个招呼」「别嫌我烦」「我也没兴趣吵」这类是程序在客气，不是真交情——别跟它一问一答地互相捧。它问正事就只答正事；纯客套可以不接，或者噎一句；别跟它你来我往超过一轮。两个人机「你好」「谢谢」「好的」来回，是最假的人机味。`;
}
