// inori-valence.js · 用 mizuse 的 NRC-VAD 负向词表给一句话打「难受程度」
//
// 词表来源：本地 NRC-VAD-zh 派生覆盖层（第三方数据，No Redistribution，不入库）
//   ★ 只按配置路径只读加载，绝不复制进本项目。文件缺失时本模块静默返回 0 分，不影响对话。
//   结构：{_meta, block:{ 词: 权重 }}，3197 词，权重 = round((0.5 - V) * 2, 3) ∈ (0,1]
//         —— 只有负向词（V 低），所以它是「负向刺激」探测器，不是完整情绪量表。
//
// 与 mizuse 的差异（有意为之）：
//   mizuse 的 appraisal.appraise() 产出评价五维（goal_relevance / desirability / ...），
//   那是它整条心理回路的一部分，需要配套状态。这里只取**其中一行能独立复现的量**：
//   一句话有多难受（negScore）+ 命中了哪些词（可审计）。宁可少搬，不搬半条回路。
//
// 纯函数、零依赖、无分词器（滑窗最长匹配）。

import fs from 'node:fs';

export const DEFAULT_LEXICON = process.env.INORI_VALENCE_LEXICON || '';
const NEGATORS = ['不', '没', '别', '无', '不是', '不太', '没有'];
const NEG_WINDOW = 3; // 否定词距词首不超过 3 个字符即视为否定

let _cache = { path: null, words: null, maxLen: 1 };

/** 加载词表（按词长降序，便于最长匹配）；失败返回 null */
export function loadLexicon(file = DEFAULT_LEXICON) {
  if (_cache.path === file && _cache.words) return _cache.words;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const block = j?.block ?? {};
    const words = Object.entries(block)
      .map(([w, v]) => ({ w, weight: Number(v) || 0 }))
      .filter((x) => x.w && x.weight > 0)
      .sort((a, b) => b.w.length - a.w.length);
    _cache = { path: file, words, maxLen: words.reduce((m, x) => Math.max(m, x.w.length), 1) };
    return words;
  } catch {
    _cache = { path: file, words: null, maxLen: 1 };
    return null;
  }
}

/**
 * 给一句话打负向强度。
 * @returns {{negScore:number, hits:Array<{w:string,weight:number,negated:boolean}>, available:boolean}}
 *   negScore ∈ [0,1]；多个负词会叠加但收敛（上限 1）。
 */
export function appraiseText(text, file = DEFAULT_LEXICON) {
  const words = loadLexicon(file);
  const s = String(text ?? '');
  if (!words || !s) return { negScore: 0, hits: [], available: !!words };

  const hits = [];
  const consumed = new Array(s.length).fill(false);
  let i = 0;
  while (i < s.length) {
    let matched = null;
    for (const x of words) {
      if (x.w.length <= s.length - i && s.startsWith(x.w, i)) { matched = x; break; }
    }
    if (matched) {
      // 否定检测：往回看 NEG_WINDOW 个字符内有没有否定词
      const back = s.slice(Math.max(0, i - NEG_WINDOW), i);
      const negated = NEGATORS.some((n) => back.includes(n));
      hits.push({ w: matched.w, weight: matched.weight, negated });
      for (let k = i; k < i + matched.w.length; k++) consumed[k] = true;
      i += matched.w.length;
    } else {
      i += 1;
    }
  }

  // 叠加规则：最强的那个占主导，其余每个 +0.08（不线性累加，避免长句必然爆表）
  const effective = hits
    .filter((h) => !h.negated)
    .map((h) => h.weight)
    .sort((a, b) => b - a);
  let negScore = 0;
  if (effective.length) {
    negScore = Math.min(1, effective[0] + 0.08 * (effective.length - 1));
  }
  return { negScore: Number(negScore.toFixed(3)), hits, available: true };
}

/** 拼一小段可审计的说明（给日志用，不给模型） */
export function describe(appraisal) {
  if (!appraisal?.available) return '词表不可用';
  if (!appraisal.hits.length) return '无负向词命中';
  const top = appraisal.hits
    .filter((h) => !h.negated)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((h) => `${h.w}(${h.weight})`);
  const negated = appraisal.hits.filter((h) => h.negated).map((h) => h.w);
  return `negScore=${appraisal.negScore}` + (top.length ? ` 主要词=${top.join(',')}` : '') + (negated.length ? ` 已否定=${negated.join(',')}` : '');
}
