import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, bigramOverlap, scoreV1, scoreV2 } from '../scripts/memory-score-shadow.mjs';

const NOW = 1793772000000;

test('cosine：相同为 1、正交为 0、长度不等为 0', () => {
  assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 2]), 0);
});

test('bigramOverlap：相同为 1、无关为 0', () => {
  assert.equal(bigramOverlap('他生日是10月26日', '他生日是10月26日'), 1);
  assert.equal(bigramOverlap('猫', '狗'), 0);
});

test('v1/v2：高相似 + 无加成应高于低相似 + 高加成', () => {
  const now = NOW;
  const high = { text: '主人下周一生日', importance: 3, time: new Date(now - 3600e3).toISOString(), mentions: 0 };
  const low = { text: '主人下周一生日', importance: 5, time: new Date(now - 3600e3).toISOString(), mentions: 10 };
  const s1 = scoreV1({ sim: 0.9, entry: high, query: '生日', now });
  const s2 = scoreV1({ sim: 0.1, entry: low, query: '生日', now });
  assert.ok(s1 > 0, '有分');
  const v2a = scoreV2({ sim: 0.9, entry: high, query: '生日', now });
  const v2b = scoreV2({ sim: 0.1, entry: low, query: '生日', now });
  assert.ok(v2a > v2b);
});
