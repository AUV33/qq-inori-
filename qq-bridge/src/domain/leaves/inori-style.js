// inori-style.js · 分条与句长：把"用逗号缝成的长句"拆回多条气泡
//
// 依据（她最近 63 条发言 vs 真人基线 31291 条）：
//   她：平均句长 11.6 字 / ≤6 字占 15.9% / 12.7% 的消息带 ≥2 个逗号
//   真人：平均 8.1 字 / ≤6 字占 58.2% / 一次说多句只占 3.2%
// 结论：她的"分段问题"不是分太多，而是该分的时候用逗号缝成了一条长句。
//
// 这里只做**机械拆分**：逗号处断气泡；太短的片段并回前一条；条数超上限就整条保留。

export const DEFAULTS = {
  minTotalChars: 12, // 短于此不拆（"行吧""谁笨蛋了"不该被拆）
  maxBubbles: 3,     // 一条最多拆成几条
  minClauseChars: 3, // 短于此的片段并回前一条
};

// [BRACKET-SAFE] 括号里的逗号不算断句点。
// 之前「那个不吃显卡，吃时间」会被拆成「那个不吃显卡 / 吃时间」两条——
// 群里看着就是每条都挂着半边括号。成对的括号内部一律不切。
const PAIRS = { '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '《': '》', '“': '”', '"': '"', '‘': '’' };

/** 只在括号外的逗号处切；未闭合的括号视为"后面都不切"（宁可整条发，也不发半个括号） */
function splitTopLevel(text) {
  const out = [];
  let cur = '';
  const stack = [];
  for (const ch of String(text ?? '')) {
    if (PAIRS[ch]) { stack.push(PAIRS[ch]); cur += ch; continue; }
    if (stack.length && ch === stack[stack.length - 1]) { stack.pop(); cur += ch; continue; }
    if (!stack.length && /[，,、]/.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * @param {string[]} messages 原始气泡数组
 * @param {{enabled?:boolean, minTotalChars?:number, maxBubbles?:number, minClauseChars?:number}} cfg
 * @returns {string[]}
 */
export function splitClauses(messages, cfg = {}) {
  const o = { ...DEFAULTS, ...cfg };
  if (o.enabled === false) return [...(messages ?? [])];
  const minTotal = Math.max(6, Number(o.minTotalChars) || DEFAULTS.minTotalChars);
  const maxBubbles = Math.max(2, Math.min(4, Number(o.maxBubbles) || DEFAULTS.maxBubbles));
  const minClause = Math.max(1, Number(o.minClauseChars) || DEFAULTS.minClauseChars);

  const out = [];
  for (const raw of messages ?? []) {
    const text = String(raw ?? '');
    if ([...text].length < minTotal || !/[，,、]/.test(text)) { out.push(text); continue; }

    const parts = splitTopLevel(text).map((s) => s.trim()).filter(Boolean);
    const merged = [];
    for (const p of parts) {
      if (merged.length && [...p].length < minClause) merged[merged.length - 1] += '，' + p;
      else merged.push(p);
    }
    if (merged.length < 2 || merged.length > maxBubbles) { out.push(text); continue; }
    out.push(...merged);
  }
  return out;
}
