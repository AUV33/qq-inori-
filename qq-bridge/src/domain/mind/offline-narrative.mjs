// offline-narrative.mjs · 离线叙事：把“我不在时发生了什么”变成一句可读的事实
//
// 干什么：从 LifeLog 的事件里做确定性摘要（不调模型）：收发了多少、来过哪些会话、
//         睡过/醒过、反思/错误；用于启动自述、唤醒上下文与反思素材。
// 为什么：A1 自我连续性要求“重启后还是同一个她”；现状重启等于失忆，LifeLog 已有数据却没人消费。
// 输入输出：纯函数；events 数组进，{text, stats} 出。
// 失败模式：坏事件跳过；空事件给出“没有中断”的短句；文本有上限。
// 不做什么：不读文件、不调模型、不决定要不要告诉用户。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.1（主观时间与生命线）

export const OFFLINE_NARRATIVE_VERSION = 1;
export const MAX_TEXT_CHARS = 360;

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function shortKey(key) {
  if (typeof key !== 'string' || !key) return '';
  const m = key.match(/^(group|private):(.+?)(#owner)?$/);
  if (!m) return key;
  return (m[1] === 'group' ? '群' : '私聊') + ':' + m[2];
}

/**
 * @param {Array<object>} events 生命线事件（任意顺序，内部按 at 排序）
 * @param {{now?:number, maxKeys?:number}} options
 */
export function summarizeOffline(events, options = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  list.sort((a, b) => num(a.at) - num(b.at));
  const now = Number.isFinite(options.now) ? options.now : (list.length ? num(list.at(-1).at) : Date.now());
  const maxKeys = Number.isFinite(options.maxKeys) ? options.maxKeys : 4;

  const stats = {
    events: list.length,
    received: 0,
    sent: 0,
    keys: new Map(),
    lastByKey: new Map(),
    sleeps: 0,
    wakes: 0,
    reflections: 0,
    errors: 0,
    firstAt: list.length ? num(list[0].at) : 0,
    lastAt: list.length ? num(list.at(-1).at) : 0,
    gapHours: 0,
  };
  if (stats.firstAt > 0) stats.gapHours = Math.max(0, (now - stats.firstAt) / 3600000);

  for (const event of list) {
    const type = typeof event.type === 'string' ? event.type : '';
    const key = typeof event.key === 'string' ? event.key : '';
    if (type === 'message.received') { stats.received += 1; }
    else if (type === 'message.sent') { stats.sent += 1; }
    else if (type === 'sleep.started') { stats.sleeps += 1; }
    else if (type === 'sleep.ended') { stats.wakes += 1; }
    else if (type === 'reflection.completed') { stats.reflections += 1; }
    else if (type === 'error.observed') { stats.errors += 1; }
    if (key && (type === 'message.received' || type === 'message.sent')) {
      stats.keys.set(key, (stats.keys.get(key) || 0) + 1);
      stats.lastByKey.set(key, num(event.at));
    }
  }

  const parts = [];
  if (stats.received || stats.sent) {
    const keyCount = stats.keys.size;
    parts.push('收到 ' + stats.received + ' 条、发出 ' + stats.sent + ' 条（' + keyCount + ' 个会话）');
  }
  if (stats.sleeps) parts.push('睡过 ' + stats.sleeps + ' 次' + (stats.wakes ? '、醒来 ' + stats.wakes + ' 次' : ''));
  if (stats.reflections) parts.push('做过 ' + stats.reflections + ' 次反思');
  if (stats.errors) parts.push('遇到过 ' + stats.errors + ' 次错误');

  let text;
  if (!list.length) {
    text = '没有中断记录：这是第一次醒来，或生命线还没有事件。';
  } else if (!parts.length) {
    text = '离开了约 ' + Math.round(stats.gapHours) + ' 小时，期间没有发生需要记住的事。';
  } else {
    text = '离开了约 ' + Math.round(stats.gapHours) + ' 小时：' + parts.join('；') + '。';
  }
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS - 1) + '…';

  const topKeys = [...stats.keys.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeys)
    .map(([key, count]) => ({ key: shortKey(key), count, lastAt: stats.lastByKey.get(key) || 0 }));

  return {
    v: OFFLINE_NARRATIVE_VERSION,
    text,
    stats: { ...stats, keys: stats.keys.size, topKeys },
  };
}
