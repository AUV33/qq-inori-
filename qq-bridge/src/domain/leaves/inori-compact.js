// inori-compact.js · 记忆压缩（确定性 consolidation）
//
// 参照 mem0 的 consolidation / Generative Agents 的 reflection-summary / Zep 的时序摘要：
// 群聊摘要（group-digest）越攒越多，检索时全是"谁在聊什么"的原料。这里把「过期且超出保留窗」的
// digest 压成一条 kind=group-compact 的摘要（保留时间跨度 + 抽样原文 + 条数），原 digest 删除。
//
// 纪律：零 LLM；压缩只动 group-digest（事实/事件/群像/浏览记录不碰）；压前调用方负责备份。

export const DEFAULTS = {
  afterDays: 3,     // 早于 N 天的 digest 才可能被压
  keepRecent: 20,   // 每个群永远保留最近 N 条 digest 原文
  maxChars: 600,    // 压缩摘要正文上限
};

const DAY = 24 * 3600 * 1000;

function oneLine(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 计算压缩计划（纯函数）。
 * @param {Array} entries 记忆条目
 * @param {{now?:number, afterDays?:number, keepRecent?:number, maxChars?:number}} [opts]
 * @returns {{entries:Array, compacted:number, summary:object|null}}
 */
export function planCompaction(entries, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const afterDays = Math.max(0, Number(opts.afterDays ?? DEFAULTS.afterDays));
  const keepRecent = Math.max(1, Number(opts.keepRecent ?? DEFAULTS.keepRecent));
  const maxChars = Math.max(80, Number(opts.maxChars ?? DEFAULTS.maxChars));
  const list = Array.isArray(entries) ? entries : [];
  const digests = list.filter((e) => e && e.kind === 'group-digest' && oneLine(e.text));
  // 永远保留最近 keepRecent 条 digest
  const keepSet = new Set(digests.slice(-keepRecent).map((e) => e));
  const cutoff = now - afterDays * DAY;
  const candidates = digests.filter((e) => !keepSet.has(e) && (() => {
    const t = Date.parse(String(e.time || '').replace(' ', 'T'));
    return Number.isFinite(t) && t < cutoff;
  })());
  if (!candidates.length) return { entries: list.slice(), compacted: 0, summary: null };
  // 抽样：均匀取最多 8 条原文，拼成压缩摘要
  const step = Math.max(1, Math.ceil(candidates.length / 8));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < 8; i += step) picked.push(oneLine(candidates[i].text));
  const firstDay = String(candidates[0]?.day || '');
  const lastDay = String(candidates[candidates.length - 1]?.day || '');
  const head = `【压缩】${candidates.length} 条群聊摘要（${firstDay}${lastDay && lastDay !== firstDay ? `~${lastDay}` : ''}）：`;
  const body = oneLine(picked.join(' / ')).slice(0, maxChars);
  const d = new Date(now);
  const day = d.toLocaleDateString('sv-SE');
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const summary = {
    day,
    time: `${day} ${hm}`,
    kind: 'group-compact',
    text: head + body,
    src: 'auto',
    compactedFrom: candidates.length,
  };
  const kept = list.filter((e) => !candidates.includes(e));
  kept.push(summary);
  return { entries: kept, compacted: candidates.length, summary };
}

/** 从文件里读（jsonl 数组），调用方负责写入。 */
/**
 * [FACT-CAP] 事实层上限：超过 maxFacts 时，最旧的 fact 进入 overflow（调用方搬 _archive，仍可检索）。
 * 只动 kind=fact/group-fact；时间解析不出的当新条目保留。
 */
export function splitFactsForCap(entries, { maxFacts = 300 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const isFact = (e) => e && (e.kind === 'fact' || e.kind === 'group-fact');
  const facts = list.filter(isFact);
  if (facts.length <= maxFacts) return { keep: list.slice(), overflow: [] };
  const byAge = facts.slice().sort((a, b) => {
    const ta = Date.parse(String(a.time || a.day || '').replace(' ', 'T'));
    const tb = Date.parse(String(b.time || b.day || '').replace(' ', 'T'));
    return (Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER) - (Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER);
  });
  const overflowSet = new Set(byAge.slice(0, facts.length - maxFacts));
  return { keep: list.filter((e) => !overflowSet.has(e)), overflow: byAge.slice(0, facts.length - maxFacts) };
}

export function parseEntries(lines) {
  return (Array.isArray(lines) ? lines : String(lines ?? '').split('\n'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function serializeEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((x) => JSON.stringify(x)).join('\n') + '\n';
}
