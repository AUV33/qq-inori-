// recall-eval.mjs · 召回金标准评估（纯函数；评估侧，随脚本走）
//
// 干什么：给定“查询 → 期望命中的记忆片段”，把检索结果的 NDCG@k 算出来。
// 为什么：CodeBuddy 审计指出项目只有自报告评估；要证明 v1/v2 谁更好，需要可复算的金标准。
// 输入输出：纯函数；rankedIds/relevantIds 或 queries+retrieve 进，指标出。
// 失败模式：空集合返回 0，不抛错。
// 不做什么：不读文件、不调用模型；取数由脚本负责。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.11 / R8

export const RECALL_EVAL_VERSION = 1;

function dcg(relevances) {
  return relevances.reduce((sum, rel, i) => sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
}

/**
 * NDCG@k：relevance 为 0/1（命中/未命中）。
 * @param {string[]} rankedIds 检索结果（已排序）
 * @param {Iterable<string>} relevantIds 期望命中的 id
 * @param {number} k
 */
export function ndcgAt(rankedIds, relevantIds, k = 5) {
  const rel = new Set(relevantIds || []);
  const list = (Array.isArray(rankedIds) ? rankedIds : []).slice(0, Math.max(1, k));
  if (!rel.size || !list.length) return 0;
  const gains = list.map((id) => (rel.has(String(id)) ? 1 : 0));
  const idealN = Math.min(rel.size, Math.max(1, k));
  const ideal = Array.from({ length: idealN }, () => 1);
  const d = dcg(gains);
  const i = dcg(ideal);
  return i ? Number((d / i).toFixed(4)) : 0;
}

/**
 * @param {{queries: Array<{query:string, expect:string[], scope?:string}>, retrieve:(q:object)=>string[], k?:number}} input
 */
export function evaluateGolden(input = {}) {
  const queries = Array.isArray(input.queries) ? input.queries : [];
  const retrieve = typeof input.retrieve === 'function' ? input.retrieve : () => [];
  const k = Number.isFinite(input.k) ? input.k : 5;
  const rows = [];
  for (const q of queries) {
    if (!q || typeof q.query !== 'string' || !Array.isArray(q.expect) || !q.expect.length) continue;
    const rankedIds = retrieve(q) || [];
    const relevant = rankedIds.filter((id) => {
      const text = String(id);
      return q.expect.some((e) => text.includes(String(e)));
    });
    rows.push({ query: q.query, scope: q.scope || '', hits: relevant.length, ndcg: ndcgAt(rankedIds, relevant, k) });
  }
  const mean = rows.length ? rows.reduce((s, r) => s + r.ndcg, 0) / rows.length : 0;
  return { v: RECALL_EVAL_VERSION, count: rows.length, meanNdcg: Number(mean.toFixed(4)), rows };
}
