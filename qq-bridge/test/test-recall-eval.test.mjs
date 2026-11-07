import test from 'node:test';
import assert from 'node:assert/strict';

import { ndcgAt, evaluateGolden } from '../scripts/lib/recall-eval.mjs';

test('ndcgAt：完美排序=1；未命中=0；空集=0', () => {
  assert.equal(ndcgAt(['a', 'b', 'c'], ['a', 'b'], 3), 1);
  assert.equal(ndcgAt(['x', 'y'], ['a'], 2), 0);
  assert.equal(ndcgAt([], ['a'], 5), 0);
  assert.equal(ndcgAt(['a'], [], 5), 0);
});

test('ndcgAt：把命中排后面会降分', () => {
  const top = ndcgAt(['a', 'x', 'y'], ['a'], 3);
  const low = ndcgAt(['x', 'y', 'a'], ['a'], 3);
  assert.ok(top > low);
});

test('evaluateGolden：query→retrieve→按期望片段算 NDCG', () => {
  const queries = [
    { query: '生日', expect: ['10月26日'] },
    { query: '猫', expect: ['喜欢猫'] },
  ];
  const retrieve = (q) => (q.query === '生日' ? ['他生日是10月26日', '无关'] : ['无关', '他喜欢猫']);
  const r = evaluateGolden({ queries, retrieve, k: 2 });
  assert.equal(r.count, 2);
  assert.ok(r.meanNdcg > 0 && r.meanNdcg <= 1);
  assert.equal(r.rows[0].hits, 1);
});

test('evaluateGolden：非法行跳过；空输入不炸', () => {
  const r = evaluateGolden({ queries: [{}, null, { query: 'x' }], retrieve: () => [] });
  assert.equal(r.count, 0);
  assert.equal(r.meanNdcg, 0);
});
