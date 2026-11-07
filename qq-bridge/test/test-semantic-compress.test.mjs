// test-semantic-compress.test.mjs · §5.11：同类 fact 压缩，不相关不硬并，情景不参与。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compressFacts } from '../src/domain/memory/semantic-compress.mjs';
import { consolidateSimilar, consolidateWithSemantic } from '../src/domain/memory/memory-consolidate.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const fact = (over) => ({ kind: 'fact', pinned: true, text: '一条事实', theme: '吃', mentions: 1, importance: 3, ...over });

test('同类相关事实合并：两条都在、pinned、mentions 相加', () => {
  const r = compressFacts([
    fact({ id: 'a', text: '喜欢吃披萨', mentions: 2 }),
    fact({ id: 'b', text: '喜欢吃意餐', mentions: 3 }),
  ], { now: T });
  assert.equal(r.entries.length, 1);
  assert.equal(r.dropped, 1);
  assert.equal(r.entries[0].kind, 'fact');
  assert.equal(r.entries[0].pinned, true);
  assert.equal(r.entries[0].mentions, 5);
  assert.match(r.entries[0].text, /披萨/);
  assert.match(r.entries[0].text, /意餐/);
  assert.deepEqual(r.entries[0].mergedFrom, ['a', 'b']);
  assert.equal(r.groups.length, 1);
});

test('不相关/不同主题/情景/低相似：不合并', () => {
  const r = compressFacts([
    fact({ id: 'a', text: '喜欢吃披萨', theme: '吃' }),
    fact({ id: 'b', text: '工作在北京', theme: '工作' }),
    fact({ id: 'c', text: '今天吃了披萨', theme: '吃', kind: 'episode', pinned: false }),
    fact({ id: 'd', text: '完全不同的饮食偏好', theme: '吃' }),
  ], { now: T });
  assert.equal(r.entries.length, 4, '不同主题/情景/低相似都不该并');
  assert.equal(r.dropped, 0);
});

test('坏条目保留；超长不合并；合并幂等（再压不产生新组）', () => {
  const r = compressFacts([
    fact({ id: 'a', text: 'x'.repeat(150) }),
    fact({ id: 'b', text: 'x'.repeat(150) }),
    { text: '没有 kind 的条目' },
    null,
  ], { now: T, maxChars: 100 });
  assert.ok(r.entries.length >= 3, '超长放弃合并、坏条目保留');

  const once = compressFacts([fact({ id: 'a', text: '喜欢猫' }), fact({ id: 'b', text: '喜欢狗' })], { now: T });
  const twice = compressFacts(once.entries, { now: T });
  assert.equal(twice.groups.length, 0, '已压缩的不再重复压');
});

test('consolidateWithSemantic：默认与旧行为一致；semantic=true 才压缩', () => {
  const entries = [fact({ id: 'a', text: '喜欢猫', theme: '宠物' }), fact({ id: 'b', text: '喜欢狗', theme: '宠物' })];
  const base = consolidateSimilar(entries, { threshold: 0.85 });
  const off = consolidateWithSemantic(entries, { threshold: 0.85 });
  assert.deepEqual(off.keep, base.keep);
  assert.equal(off.semantic.groups.length, 0);

  const on = consolidateWithSemantic(entries, { threshold: 0.85, semantic: true, now: T });
  assert.equal(on.keep.length, 1);
  assert.match(on.keep[0].text, /猫/);
  assert.match(on.keep[0].text, /狗/);
});

test('接线：memory-maint 走 consolidateWithSemantic，且显式 opt-in', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'src/domain/leaves/inori-memory-maint.js'), 'utf8');
  assert.match(src, /consolidateWithSemantic/);
  assert.match(src, /semanticCompress === true/);
});
