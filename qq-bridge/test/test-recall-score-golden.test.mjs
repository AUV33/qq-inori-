// 召回打分金标准：同一批合成候选上，v2（归一化）应比 v1（相似度+常数）更贴近“语义相关”。
// 不依赖嵌入服务：相似度是注入的合成值；这里验证的是排序函数本身。
import test from 'node:test';
import assert from 'node:assert/strict';

import { rankScore, rankScoreV2 } from '../src/domain/leaves/inori-momentum.js';

const NOW = 1793772000000;
const FRESH = NOW - 3600e3; // 1 小时内

function v1Score(c) {
  const kindW = (c.kind || 0) * 0.04;
  const impW = ((c.importance ?? 3) - 3) * 0.02;
  const recW = 0.05; // 近 3 天
  const lexW = c.lexical || 0;
  return rankScore({ similarity: c.sim, momentum: c.momentum || 0, lastAt: c.lastAt || FRESH }, NOW) + kindW + impW + recW + lexW;
}

function v2Score(c) {
  return rankScoreV2({
    similarity: c.sim,
    importance: c.importance ?? 3,
    momentum: c.momentum || 0,
    lastAt: c.lastAt || FRESH,
    boosts: { lexical: c.lexical || 0, kind: (c.kind || 0) },
  }, NOW);
}

function ndcgAt(items, k, relevanceOf) {
  const sorted = [...items].sort((a, b) => b.score - a.score).slice(0, k);
  const dcg = sorted.reduce((sum, it, i) => sum + (2 ** relevanceOf(it) - 1) / Math.log2(i + 2), 0);
  const ideal = [...items].map((it) => ({ it, rel: relevanceOf(it) })).sort((a, b) => b.rel - a.rel).slice(0, k)
    .reduce((sum, x, i) => sum + (2 ** x.rel - 1) / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
}

const CASES = [
  { id: 'A', sim: 0.95, importance: 2, momentum: 0.0, lexical: 0.0, kind: 0 },
  { id: 'B', sim: 0.15, importance: 5, momentum: 1.0, lexical: 0.20, kind: 1 },
  { id: 'C', sim: 0.80, importance: 3, momentum: 0.1, lexical: 0.0, kind: 0 },
  { id: 'D', sim: 0.65, importance: 4, momentum: 0.4, lexical: 0.1, kind: 0 },
  { id: 'E', sim: 0.55, importance: 1, momentum: 0.0, lexical: 0.05, kind: -1 },
  { id: 'F', sim: 0.45, importance: 2, momentum: 0.2, lexical: 0.0, kind: 0 },
  { id: 'G', sim: 0.30, importance: 5, momentum: 0.6, lexical: 0.15, kind: 1 },
  { id: 'H', sim: 0.20, importance: 4, momentum: 0.3, lexical: 0.0, kind: -1 },
  { id: 'I', sim: 0.10, importance: 3, momentum: 0.1, lexical: 0.2, kind: 0 },
  { id: 'J', sim: 0.05, importance: 2, momentum: 0.0, lexical: 0.0, kind: 0 },
];

test('v2：高语义相似度的不会被字面/重要度常数压下去', () => {
  const a = { ...CASES[0] }; const b = { ...CASES[1] };
  assert.ok(v1Score(b) > v1Score(a), 'v1 确实会让常数项压过语义');
  assert.ok(v2Score(a) > v2Score(b), 'v2 应保持语义优先');
});

test('v2：NDCG@5 不低于 v1（相关性=语义相似度）', () => {
  const relevance = (c) => c.sim;
  const v1 = CASES.map((c) => ({ ...c, score: v1Score(c) }));
  const v2 = CASES.map((c) => ({ ...c, score: v2Score(c) }));
  const n1 = ndcgAt(v1, 5, relevance);
  const n2 = ndcgAt(v2, 5, relevance);
  assert.ok(n2 >= n1, 'v2 NDCG ' + n2.toFixed(3) + ' < v1 ' + n1.toFixed(3));
});

test('v2：0..1 有界；确定性', () => {
  for (const c of CASES) {
    const s = v2Score(c);
    assert.ok(Number.isFinite(s) && s >= 0 && s <= 1, c.id + '=' + s);
  }
  assert.equal(v2Score(CASES[3]), v2Score(CASES[3]));
});
