// inori-sessions.js · 「你现在参与的会话」清单
//
// 为什么需要它：桥接按 key 分会话（private:xxx / group:xxx），她每轮只知道自己眼前这一个。
// 于是「群里看到某人 → 私聊他 → 回群里再提」这种事她想不到，因为她的上下文里没有
// “我还在别处说话”这个事实。这里只递事实：还有哪些会话、多近、有没有未读、哪个是当前。
// 不替她判断该跟谁说话，也不搬运任何会话内容。

const MAX_ENTRIES_DEFAULT = 6;

function labelOf(key) {
  const m = /^(group|private):(\d+)$/i.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1].toLowerCase(), id: m[2] };
}

/** 相对时间：只给粗粒度，够她判断“热不热”即可 */
export function relativeTime(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const gap = Math.max(0, Number(now) - t);
  const min = Math.floor(gap / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

function activityOf(st) {
  const a = Number(st?.lastIncomingAt) || 0;
  const b = Number(st?.lastAiReplyAt) || 0;
  return Math.max(a, b);
}

/**
 * 渲染会话清单。纯函数，不读文件、不碰全局状态。
 * @param {Array<{key: string} & object>} conversations 每个会话的状态对象（需带 key）
 * @param {{currentKey?: string, now?: number, max?: number}} options
 * @returns {string} 一段可直接拼进提示词的文本；没有可用会话时返回 ''
 */
export function renderConversations(conversations, options = {}) {
  const { currentKey = '', now = Date.now(), max = MAX_ENTRIES_DEFAULT } = options;
  const limit = Math.max(1, Number(max) || MAX_ENTRIES_DEFAULT);
  const rows = [];
  for (const st of Array.isArray(conversations) ? conversations : []) {
    if (!st || typeof st !== 'object') continue;
    const key = String(st.key ?? '');
    const parsed = labelOf(key);
    if (!parsed) continue;
    const at = activityOf(st);
    if (!at) continue; // 从没说过话的会话不给（避免把白名单里的空壳列出来）
    rows.push({ key, ...parsed, at, unread: Array.isArray(st.unread) ? st.unread.length : 0 });
  }
  if (!rows.length) return '';

  rows.sort((a, b) => {
    if (a.key === currentKey) return -1;
    if (b.key === currentKey) return 1;
    return b.at - a.at;
  });

  const lines = rows.slice(0, limit).map((r) => {
    const parts = [`${r.kind === 'group' ? '群' : '私聊'} ${r.id}`];
    if (r.key === currentKey) parts.push('当前这个');
    const when = relativeTime(r.at, now);
    if (when) parts.push(when);
    if (r.unread > 0) parts.push(`未读 ${r.unread}`);
    return `- ${parts.join(' · ')}`;
  });

  const more = rows.length > limit ? `\n（还有 ${rows.length - limit} 个没列）` : '';
  return `【你手头的会话】你不止在眼前这一处说话，这些地方你都在：
${lines.join('\n')}${more}
想跟谁说话就发到那个会话；把别的会话里的事拿到这里说时，讲清楚是从哪儿听来的。`;
}
