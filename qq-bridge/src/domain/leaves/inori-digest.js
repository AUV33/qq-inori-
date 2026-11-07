// inori-digest.js · 把一天的消息压成一条摘要（分层摘要的第一层）
//
// 为什么需要：recentMessages 只留 100 条，更早的消息**直接消失**——
// 她过了几天就完全不记得那几天发生过什么。Zep/Letta 的做法是分层摘要：
//   原始消息 → 每条/每 10 条 → 每会话 → 每天 → 每周
// 这里做最小的第一层：一天一条，进事实层（memory.jsonl）。
//
// 原则：
//   1) 纯函数，可断言
//   2) 不编内容——只做排序、去重、截断、拼接，不生成新语义
//   3) 有硬上限（默认 400 字），避免把记忆库撑爆

export const DEFAULTS = {
  maxChars: 400,      // 摘要总长
  perLineChars: 40,   // 每条消息保留多少字
  maxLines: 8,        // 最多拼几条
  minMessages: 6,     // 少于这么多条就不值得摘要
};

const len = (s) => [...String(s ?? '')].length;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\[表情\d*\]/g, '').trim();

/**
 * 从一天的消息里挑出"值得记的"并压成一段摘要
 * @param {{sender?:string, text?:string, isSelf?:boolean, at?:number}[]} messages
 * @returns {{ok:boolean, text:string, used:number, total:number, reason?:string}}
 */
export function digestDay(messages, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const all = (messages ?? []).filter((m) => m && clean(m.text || m.plain));
  if (all.length < o.minMessages) return { ok: false, text: '', used: 0, total: all.length, reason: 'too-few' };

  // 1) 去重（同一句话重复刷屏只留一次）
  const seen = new Set();
  const uniq = [];
  for (const m of all) {
    const t = clean(m.text || m.plain);
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push({ ...m, text: t });
  }

  // 2) 打分：长一点、有人问、提到她 → 更像"发生过的事"
  const score = (m) => {
    let s = Math.min(3, len(m.text) / 12);
    if (/[?？]/.test(m.text)) s += 1;
    if (/ai|机器人|bot|助手|inori/i.test(m.text)) s += 1.5;
    if (m.isSelf) s += 0.3;   // 她说的也算，但权重略低
    return s;
  };

  // 3) 按时间前 1/3、中 1/3、后 1/3 各取一些，保持"一天的走向"而不是只留最热闹的
  const sorted = [...uniq].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const buckets = [sorted.slice(0, third), sorted.slice(third, third * 2), sorted.slice(third * 2)];
  const picked = [];
  const quota = Math.max(1, Math.floor(o.maxLines / 3));
  for (const b of buckets) {
    picked.push(...b.sort((x, y) => score(y) - score(x)).slice(0, quota));
  }

  // 4) 拼：谁说了什么（同一人只标注一次，避免全是名字）
  const lines = [];
  let total = 0;
  const SEP = ' / ';
  for (const m of picked) {
    const who = m.isSelf ? '我' : (clean(m.sender) || '某人');
    const body = [...m.text].slice(0, o.perLineChars).join('');
    const line = `${who}：${body}`;
    // [SEP-COUNT] 分隔符也要计入上限，否则拼出来的总长会超过 maxChars（实测 132 > 120）
    const add = len(line) + (lines.length ? len(SEP) : 0);
    if (total + add > o.maxChars) break;
    lines.push(line);
    total += add;
  }
  if (!lines.length) return { ok: false, text: '', used: 0, total: all.length, reason: 'empty' };
  return { ok: true, text: lines.join(' / '), used: lines.length, total: all.length };
}

/** 判断某个日期是否已经摘要过（摘要写成 kind=day-digest，text 里带日期） */
export function alreadyDigested(entries, day) {
  return (entries ?? []).some((e) => e && e.kind === 'day-digest' && String(e.text ?? '').includes(day));
}
