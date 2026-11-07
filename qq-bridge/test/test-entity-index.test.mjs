// test-entity-index.test.mjs · S7d-d：轻量实体索引 + 实体边参与联想。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEntityIndex, extractMentions, createEntityExtractor, sharedEntityWeight,
} from '../src/domain/memory/entity-index.mjs';
import { buildAssociationGraph, spreadActivation } from '../src/domain/memory/assoc-activation.mjs';

const T = Date.UTC(2026, 10, 5, 4);
const e = (over) => ({ text: '一条记忆', who: '他', theme: '', recordedAt: T, ...over });

test('实体表：忽略短名/重复；最长优先提取；max 限制', () => {
  const idx = buildEntityIndex(['小明', '小明', '小红', '明', { name: '披萨', id: 'food:pizza' }]);
  assert.equal(idx.names.length, 3);
  assert.deepEqual(extractMentions('今天和小明、小红吃了披萨', idx), ['小明', '小红', 'food:pizza']);
  assert.deepEqual(extractMentions('小明小明小明', idx, { max: 1 }), ['小明']);
  assert.deepEqual(extractMentions('没有实体', idx), []);
  assert.equal(sharedEntityWeight(['a', 'b'], ['b', 'c']), 0.5);
  assert.equal(sharedEntityWeight([], ['a']), 0);
});

test('实体边：文本共同提到同一人即可连；没有 entityOf 不连', () => {
  const idx = buildEntityIndex(['小明', '小红']);
  const entityOf = createEntityExtractor(idx);
  const a = e({ id: 'a', text: '小明说他今天加班', who: '甲', theme: '工作' });
  const b = e({ id: 'b', text: '小红问小明几点回', who: '乙', theme: '生活', recordedAt: T + 30 * 86400000 });
  const withEntity = buildAssociationGraph([a, b], { now: T, entityOf });
  assert.ok(withEntity.edges.get('a').some((x) => x.to === 'b' && x.kind.includes('entity')));
  const without = buildAssociationGraph([a, b], { now: T });
  assert.equal(without.edges.get('a').some((x) => x.kind.includes('entity')), false);

  const spread = spreadActivation(withEntity, ['a'], { topK: 2 });
  assert.ok(spread.activated.some((x) => x.key === 'b'), '实体边也能扩散');
});

test('接线：memory-retrieve 把 entityOf 透传给联想图', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'src/domain/memory/memory-retrieve.js'), 'utf8');
  assert.match(src, /entityOf: opts\.entityOf/);
});
