// inori-knowledge.mjs · 「从查到记」的挑选规则（纯函数，零 IO）
//
// 背景（2026-10-30）：
//   她查外部资料（prts / wiki）时，结果只活在那一轮对话的上下文里，回合结束就蒸发。
//   能落地的只有 memory / cognition 两个显式写入口，但她要自己想到去写 —— 实际一条没写
//   （cognition 里 5 条全是关于他/群，没有 about-world）。
//
// 这条链路补的是「第二次出场」：把**她反复查过、却一直没记下来**的东西摆回眼前。
// 纪律（判定权在她）：
//   1. 不替她总结：候选只放「工具 + 主体 + 查过几次」，事实怎么压缩是她自己的事；
//   2. 同一 (工具, 主体) 查 ≥2 次才提议（跨事件、时间上拉开 ≥60s），一次性查询不污染；
//   3. 不催：措辞只给事实 + 许可，7 天自己过期；
//   4. 已经写过同类认知（二元组重合 ≥ 0.35）的，不再出现 —— 写了就自动「消费」掉。
//
// 数据源是桥接已有的 state/tool-calls.jsonl（appendToolLog），不新增账本文件。

import { overlap } from './inori-cognition.js';

// 只认「事实类」查询。search_prts 是检索不是事实，不记。
export const KNOWLEDGE_TOOLS = Object.freeze({
  'mcp__prts__get_stage_info': { label: '关卡详情', argKeys: ['stage_id'] },
  'mcp__prts__get_stage_enemies': { label: '关卡敌人', argKeys: ['stage_id'] },
  'mcp__prts__get_operator_basic_info': { label: '干员信息', argKeys: ['name'] },
  'mcp__prts__get_enemy_info': { label: '敌人详情', argKeys: ['name', 'enemy_id'] },
});

export const DEFAULT_MIN_HITS = 2;
export const DEFAULT_MIN_GAP_MS = 60_000;
export const DEFAULT_TTL_DAYS = 7;
export const DEFAULT_MAX_CANDIDATES = 2;
export const DEFAULT_MIN_OVERLAP = 0.35;

export function isKnowledgeTool(tool) {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_TOOLS, String(tool ?? ''));
}

/** 工具参数在日志里常常是 JSON 字符串（还可能双层转义），逐层解析，失败就当没有。 */
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  let text = String(raw ?? '').trim();
  for (let i = 0; i < 4 && text; i += 1) {
    try {
      const next = JSON.parse(text);
      if (next && typeof next === 'object') return next;
      text = String(next ?? '');
    } catch { return {}; }
  }
  return {};
}

/** 这次查询「关于什么」：取该工具的主参数。取不到就不算可记的知识（也避免把整串 JSON 当主体）。 */
export function subjectOf(tool, args) {
  const spec = KNOWLEDGE_TOOLS[String(tool ?? '')];
  if (!spec) return '';
  for (const key of spec.argKeys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 40);
  }
  return '';
}

/**
 * 从 tool-calls 行里数出「反复查过的知识」。
 * @param {Array<object>} rows tool-calls.jsonl 的行
 * @returns {Array<{tool:string, subject:string, hits:number, firstAt:number, lastAt:number}>}
 */
export function collectLookups(rows, {
  now = Date.now(), days = DEFAULT_TTL_DAYS, minHits = DEFAULT_MIN_HITS, minGapMs = DEFAULT_MIN_GAP_MS,
} = {}) {
  const since = now - days * 86400000;
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.type !== 'call') continue;
    const tool = String(row.tool ?? '');
    if (!isKnowledgeTool(tool)) continue;
    const at = Date.parse(String(row.time ?? row.ts ?? ''));
    if (!Number.isFinite(at) || at < since) continue;
    const subject = subjectOf(tool, parseArgs(row.args));
    if (!subject) continue;
    const key = `${tool}|${subject}`;
    const current = map.get(key) ?? { tool, subject, hits: 0, firstAt: at, lastAt: at };
    current.hits += 1;
    current.firstAt = Math.min(current.firstAt, at);
    current.lastAt = Math.max(current.lastAt, at);
    map.set(key, current);
  }
  return [...map.values()]
    .filter((item) => item.hits >= minHits && item.lastAt - item.firstAt >= minGapMs)
    .sort((a, b) => b.hits - a.hits || b.lastAt - a.lastAt);
}

export function candidateText(lookup) {
  const label = KNOWLEDGE_TOOLS[lookup?.tool]?.label ?? '资料';
  return `${label}「${lookup?.subject ?? ''}」（查过 ${Number(lookup?.hits) || 0} 次）`;
}

/**
 * 挑出值得摆到她眼前的候选：已写过相似认知的跳过。
 * @param {Array<object>} lookups collectLookups 的结果
 * @param {Array<object>} cognitionItems cognition.load() 的结果（只用 text/when）
 */
export function pickCandidates(lookups, cognitionItems, {
  max = DEFAULT_MAX_CANDIDATES, minOverlap = DEFAULT_MIN_OVERLAP,
} = {}) {
  const written = (Array.isArray(cognitionItems) ? cognitionItems : [])
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => `${x.text} ${x.when ?? ''} ${Array.isArray(x.evidence) ? x.evidence.join(' ') : ''}`.toLowerCase());
  const out = [];
  const seen = new Set();
  for (const lookup of Array.isArray(lookups) ? lookups : []) {
    const text = candidateText(lookup);
    if (seen.has(text)) continue;
    seen.add(text);
    const subject = String(lookup.subject ?? '').toLowerCase();
    // 两种「写过」的判定：① 认知里出现同一个主体（如 main_01-07 / 能天使）；
    // ② 整句高度重合。只看整句重合会漏——她写认知时通常不会复述「关卡详情（查过 2 次）」。
    const done = written.some((one) => (subject && one.includes(subject)) || overlap(one, text) >= minOverlap);
    if (done) continue;
    out.push({ ...lookup, text });
    if (out.length >= max) break;
  }
  return out;
}

/** 注入块：只给事实 + 许可，不派任务。没有候选就不出这一段。 */
export function renderCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((x) => x && x.text) : [];
  if (!list.length) return '';
  const lines = list.map((item) => `- ${item.text}，还没记下来`);
  return `【你查过、还没记的】\n${lines.join('\n')}\n（值得长期用的就 cognition_save 记一条（kind=about-world；以前用 qq_cognition_add，要令牌，自己时间里写不了）；不用记就别管，7 天后自己过期。）`;
}
