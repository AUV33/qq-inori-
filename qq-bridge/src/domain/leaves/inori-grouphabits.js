// inori-grouphabits.js · 群习惯档案：从群里真实消息里确定性统计「这个群怎么聊」
//
// 目的：让她知道每个群的节奏（多快回、爱不爱复读、表情多不多、谁常接话），
// 而不是每个群都用同一套说话方式。
//
// 只统计群的结构与节奏（多快回、爱不爱复读、表情多不多、谁常接话）；
// 语气词统计由 register/groupmembers 层负责，学不学是她自己的事（2026-10-25 起不再禁止）。
// 不学习她自己说的话——这里只描述「群的样子」，不提炼表达。

/** 归一化文本（去占位符/标点/空白/大小写） */
function norm(t) {
  return String(t || '')
    .replace(/\[[^\]]{0,16}\]/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * @param {Array} recentMessages 该群 recentMessages（每项 {sender,text,plain,isSelf,time,media,hasMedia}）
 * @param {object} opts 可选 { now }
 * @returns {object} 统计结果
 */
export function computeGroupHabits(recentMessages, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const list = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && typeof m === 'object');
  const others = list.filter((m) => !m.isSelf);
  const self = list.filter((m) => m.isSelf);

  // 平均间隔（只算别人，间隔 > 1s 且 < 10min，避免睡眠/跨天拉爆）
  const times = others.map((m) => Number(m.time) || 0).filter((t) => t > 0).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1000 && d < 10 * 60 * 1000) gaps.push(d);
  }
  const avgGapSec = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000) : 0;

  // 复读率：相邻两条别人消息归一化后相同
  let repeatPairs = 0;
  for (let i = 1; i < others.length; i++) {
    const a = norm(others[i - 1].text || others[i - 1].plain);
    const b = norm(others[i].text || others[i].plain);
    if (a && a === b) repeatPairs += 1;
  }
  const repeatRate = others.length > 1 ? repeatPairs / (others.length - 1) : 0;

  // 表情/图片率
  const withMedia = others.filter((m) => m.hasMedia || (Array.isArray(m.media) && m.media.length)).length;
  const mediaRate = others.length ? withMedia / others.length : 0;

  // 常见短语（2~6 字，出现 ≥3 次；纯结构，不做语义）
  const freq = new Map();
  for (const m of others) {
    const t = norm(m.text || m.plain);
    if (!t || t.length < 2) continue;
    const key = t.slice(0, 24);
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const common = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => ({ text: k.slice(0, 6), count: n }));

  // 她的参与度：她发言占全群条数比例（近段）
  const myRatio = list.length ? self.length / list.length : 0;

  // 活跃小时（别人消息的小时分布 top2）
  const hours = new Map();
  for (const m of others) {
    const t = Number(m.time) || 0;
    if (!t) continue;
    const h = new Date(t).getHours();
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const activeHours = [...hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h);

  return {
    at: now,
    sample: list.length,
    others: others.length,
    selfCount: self.length,
    avgGapSec,
    repeatRate: +repeatRate.toFixed(2),
    mediaRate: +mediaRate.toFixed(2),
    myRatio: +myRatio.toFixed(2),
    common,
    activeHours,
  };
}

/** 渲染成给她的短提示（每群一份，结构描述，不抄语气） */
export function renderGroupHabits(h) {
  if (!h || !h.others) return '';
  const parts = [];
  if (h.avgGapSec) parts.push(`平均 ${h.avgGapSec} 秒一条`);
  if (h.repeatRate >= 0.15) parts.push(`经常复读（${Math.round(h.repeatRate * 100)}% 相邻消息相同）`);
  if (h.mediaRate >= 0.1) parts.push(`爱发表情/图（${Math.round(h.mediaRate * 100)}%）`);
  if (h.common.length) parts.push(`常说「${h.common.map((c) => c.text).join('」「')}」`);
  if (h.activeHours.length) parts.push(`活跃时段 ${h.activeHours.map((x) => x + '点').join('/')}`);
  parts.push(`我发言占 ${Math.round(h.myRatio * 100)}%`);
  return `【这个群的习惯】${parts.join('；')}。按这个节奏来：他们说得多就短接，他们慢就少插嘴。`;
}
