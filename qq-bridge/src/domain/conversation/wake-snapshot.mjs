import { compactModelMessage as defaultCompactModelMessage } from '../persona/qq-model-view.js';
// wake-snapshot.mjs · 把「叫你的那条 / 未读 / 之前聊的」渲染成她读得懂的文本
//
// 为什么单独成模块（2026-10-28 S2-3）：
//   这是唤醒 prompt 里最大的一块，也是她**实际读到的输入形状**。之前它把 JSON 直接塞给她
//   （约 3k 字机器格式），既费 token 又把"谁说了什么"埋进字段里，回话质量肉眼可见地差；
//   改成文本行后，格式本身就成了行为的一部分——引用 ID / 转发 / 媒体这些句柄必须原样保留，
//   否则她没法用工具去查。这类"格式契约"以前只能靠线上读日志，现在有单测锁。
//
// 纪律：
//   · 纯渲染，不读状态、不截断、不排序；"谁进来"由 buildWakeSnapshotV2 决定，"怎么显示"只在这里。
//   · 每行格式固定为 `seq<序号> <发送者>：<正文> ｜<附加句柄>…`；没有的句柄不占位。
//   · 正文里的换行压成空格（一条消息必须是一行，否则她分不清哪句是谁说的）。

/** 消息时间：今天只给 HH:MM，跨天给 MM-DD HH:MM；没有时间就不占位。 */
function clockOf(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/** 单条消息渲染成一行。 */
export function formatSnapshotLine(m) {
  const body = String(m?.text || m?.plain || '').replace(/\s+/g, ' ');
  const extras = [];
  // 引用/转发句柄必须原样保留：她要用这些调工具查引用和转发内容（不能只给正文）
  if (m?.messageId) extras.push(`引用ID=${m.messageId}`);
  if (Array.isArray(m?.forwardIds) && m.forwardIds.length) extras.push(`转发=${m.forwardIds.join(',')}`);
  if (Array.isArray(m?.nestedForwardIds) && m.nestedForwardIds.length) extras.push(`转发的转发=${m.nestedForwardIds.join(',')}`);
  if (Array.isArray(m?.media) && m.media.length) {
    extras.push(`媒体=${m.media.map((x) => (x?.faceId ? `表情${x.faceId}` : `图${x?.index ?? '?'}`)).join(',')}`);
  }
  if (m?.kind) extras.push(`类型=${m.kind}`);
  // 【他】= 主人本人。prompt 里一直写着「群里只有带【他】标记的才是他本人」，但以前
  // 只有"当前这条"和旧的 context 块带标记，这份快照没带 → 群里她分不清哪句是主人说的
  // （2026-10-29 实证：把别人说的话当成主人回的）。这里补上，和 prompt 的规则对齐。
  const ownerTag = m?.isOwner ? '【他】' : '';
  // 带上 QQ：她可以拿这个号去 qq_person 查对应用户的档案/印象（按 QQ 归一），
  // 不用靠昵称猜"这句是谁"（昵称会改、会重名、会带乱码）。
  const qq = m?.userId ? `（QQ ${m.userId}）` : '';
  // [SNAPSHOT-CLOCK] 带上这条消息的时间：没有时间戳时，她分不清"几分钟前的旧问题"和
  // "刚发的新问题"——2026-10-30 实测把 20 分钟前的「这个是你画的？」当成新消息又答了一遍。
  const clock = clockOf(m?.time);
  return `seq${m?.seq ?? '?'}${clock ? ' ' + clock : ''} ${ownerTag}${m?.sender ?? '?'}${qq}：${body}${extras.length ? ' ｜' + extras.join(' ｜') : ''}`;
}

/**
 * 渲染一次唤醒的消息快照。
 * @param {{trigger?: object, messages?: object[], recent?: object[]}} packet
 * @returns {string} 空包返回空串（调用方据此决定是否加【本次消息快照】块）
 */
export function renderWakeSnapshotV2(packet) {
  const out = [];
  if (packet?.trigger) out.push(`【叫你的那条】${formatSnapshotLine(packet.trigger)}`);
  if (Array.isArray(packet?.messages) && packet.messages.length) {
    out.push('【未读】');
    for (const m of packet.messages) out.push(formatSnapshotLine(m));
  }
  if (Array.isArray(packet?.recent) && packet.recent.length) {
    out.push('【之前聊的】');
    for (const m of packet.recent) out.push(formatSnapshotLine(m));
  }
  return out.join('\n');
}

/** 配置数字的边界收敛（原样保留 bridge 里的行为：非数字用默认，超界夹紧）。 */
function bounded(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/**
 * 组装一次唤醒的消息包：在预算内挑「最新的未读 + 必要的上下文」，并标注还差多少条。
 *
 * 这段以前是 main() 里的闭包（依赖 cfg / 状态 / 工具开关 / 读数水位），抽出来只为让
 * "预算裁掉了什么、有没有替她确认没看到的、空闲唤醒会不会把旧话当新消息"可以离线断言。
 *
 * @param {string} key
 * @param {object} deps
 * @param {() => object} deps.getState       取会话状态（延迟到确认要组装之后再调）
 * @param {object} [deps.context]            cfg.socialV2.context
 * @param {(name: string) => boolean} deps.toolEnabled
 * @param {(st: object, extra?: object[]) => number} deps.readThroughSeq 已读水位计算
 * @param {(msg: object) => object} [deps.compactModelMessage] 进包前的裁剪
 * @param {(line: string) => void} [deps.log]
 * @returns {object|null} 关闭时返回 null
 */
export function buildWakeSnapshot(key, deps = {}) {
  const { context = {}, toolEnabled, readThroughSeq, compactModelMessage = defaultCompactModelMessage, log = () => {} } = deps;
  if (context.inlineWakeMessages === false || (!toolEnabled('getUnread') && !toolEnabled('getRecent'))) return null;
  const compactMsg = (m) => defaultCompactModelMessage(compactModelMessage(m));
  const st = deps.getState();
  const maxChars = bounded(context.wakeMaxChars, 6000, 500, 20000);
  const maxUnread = bounded(context.wakeMessageLimit, 12, 1, 100);
  const maxRecent = bounded(context.wakeRecentLimit, 4, 0, 20);
  // [IDLE-SNAPSHOT] 没有未读时，唤醒来自定时/手动/超时：把已读旧话整段倒给她，她会当成新消息再回一遍。
  // 空闲唤醒只留一小截上下文，并打 readContext 标记，由 prompt 明确说“这些是已读旧话”。
  const idleRecentLimit = bounded(context.wakeRecentLimitWhenIdle, 2, 0, 20);
  const idleWake = st.unread.length === 0;
  const recentBudget = idleWake ? Math.min(maxRecent, idleRecentLimit) : maxRecent;
  const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeq(st), partial: st.unread.length > 0 };
  const tryAdd = (field, msg) => {
    const previousThrough = packet.readThroughSeq;
    packet[field].push(compactMsg(msg));
    packet.includedUnreadCount = packet.messages.length;
    packet.readThroughSeq = readThroughSeq(st, [...packet.messages, ...packet.recent]);
    packet.partial = packet.messages.length < st.unread.length;
    if (JSON.stringify(packet).length <= maxChars) return true;
    packet[field].pop();
    packet.includedUnreadCount = packet.messages.length;
    packet.readThroughSeq = previousThrough;
    packet.partial = packet.messages.length < st.unread.length;
    return false;
  };
  if (toolEnabled('getUnread')) {
    // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
    for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
  }
  if (toolEnabled('getRecent') && recentBudget > 0) {
    const unread = new Set(st.unread.map((m) => m.seq));
    const oldestUnread = st.unread.length ? Math.min(...st.unread.map((m) => Number(m.seq)).filter(Number.isSafeInteger)) : Infinity;
    // [SNAPSHOT-NO-SELF] 她自己说过的话不再放进 recent 回灌（会让模型把自己的旧话当新输入，出现复读）。
    // [SNAPSHOT-NO-BACKLOG] 有未读时，recent 只带“最早未读之前”的上下文，避免她跳过当前未读去补旧账。
    const recent = st.recentMessages.filter((m) => !m.isSelf
      && (!Number.isSafeInteger(m.seq) || !unread.has(m.seq))
      && (!st.unread.length || (Number.isSafeInteger(m.seq) && m.seq < oldestUnread))).slice(-recentBudget);
    for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
    packet.recent.reverse();
  }
  // [WAKE-TRIGGER] 「唤醒只带触发器，不把整个房间倒进来」：预算裁掉时，叫醒她的那条单独附上，
  // 但不计入 readThrough（不能替她确认没看到的）。
  const lastUnread = st.unread.length ? st.unread[st.unread.length - 1] : null;
  if (lastUnread && toolEnabled('getUnread')) {
    const includedSeqs = new Set(packet.messages.map((m) => Number(m.seq)));
    if (!includedSeqs.has(Number(lastUnread.seq))) packet.trigger = compactMsg(lastUnread);
  }
  // [UNREAD-PARTIAL] 明确还差多少条没带（不让"只看了一部分"变成静默假设）
  packet.omitted = Math.max(0, st.unread.length - packet.includedUnreadCount);
  // [AUTO-ACK] 记下「这次唤醒让她看到哪」：她说完话就自动确认这段，不用记得 mark_read。
  try { st.pendingAckSeq = packet.readThroughSeq; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-snapshot.mjs:141'); }
  // [IDLE-SNAPSHOT] 标出「这些 recent 是已读旧话」，prompt 据此加约束（不是新消息，别重答）。
  packet.readContext = idleWake && packet.recent.length > 0;
  try { log(`[wake-snapshot] ${key} unread=${packet.unreadCount} 带=${packet.includedUnreadCount} 没带=${packet.omitted} trigger=${packet.trigger ? 'yes' : 'no'} recent=${packet.recent.length}${packet.readContext ? '(已读)' : ''}`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-snapshot.mjs:144'); }
  return packet;
}

