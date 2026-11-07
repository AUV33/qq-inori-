import test from 'node:test';
import assert from 'node:assert/strict';

import { consolidateSimilar, similarity, DEFAULT_THRESHOLD } from '../src/domain/memory/memory-consolidate.mjs';

test('similarity：相同为 1、无关为 0、近似高', () => {
  assert.equal(similarity('他生日是10月26日', '他生日是10月26日'), 1);
  assert.equal(similarity('猫', '狗'), 0);
  const long = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  assert.ok(similarity(long, long.replace('日', '号')) > DEFAULT_THRESHOLD);
});

test('合并高度相似的同类事实；不同类不合并', () => {
  const base = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  const entries = [
    { kind: 'fact', text: base, time: '2026-10-23', importance: 3 },
    { kind: 'fact', text: base.replace('日', '号'), time: '2026-10-24', importance: 4 },
    { kind: 'fact', text: '他喜欢猫', time: '2026-10-25', importance: 2 },
    { kind: 'group-digest', text: base, time: '2026-10-26', importance: 2 },
  ];
  const r = consolidateSimilar(entries, { threshold: 0.85 });
  assert.equal(r.mergedCount, 1);
  assert.equal(r.keep.length, 3);
  const merged = r.keep.find((e) => e.mergedFrom);
  assert.ok(merged);
  assert.equal(merged.importance, 4);
});

test('阈值高：近似但不完全相同的保留', () => {
  const entries = [
    { kind: 'fact', text: '他生日是10月26日' },
    { kind: 'fact', text: '他生日是十月二十六' },
  ];
  const r = consolidateSimilar(entries, { threshold: 0.99 });
  assert.equal(r.mergedCount, 0);
});

test('确定性：同输入同结果；空输入不炸', () => {
  const entries = [
    { kind: 'fact', text: 'aaa111' }, { kind: 'fact', text: 'aaa111' },
  ];
  const a = consolidateSimilar(entries, { threshold: 0.9 });
  const b = consolidateSimilar(entries, { threshold: 0.9 });
  assert.deepEqual(a.keep.map((e) => e.text), b.keep.map((e) => e.text));
  assert.equal(consolidateSimilar([], {}).mergedCount, 0);
  assert.equal(consolidateSimilar(null, {}).mergedCount, 0);
});

test('合并后的派生记忆带 provenance（recordedAt 取最早、src/embedModel 保留）', () => {
  const base = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  const entries = [
    { kind: 'fact', text: base, time: '2026-10-01 10:00', recordedAt: '2026-10-01T10:00:00Z', src: 'private', embedModel: 'bge-m3@1024', importance: 3 },
    { kind: 'fact', text: base.replace('日', '号'), time: '2026-10-05 10:00', recordedAt: '2026-10-05T10:00:00Z', src: 'private', embedModel: 'bge-m3@1024', importance: 4 },
  ];
  const r = consolidateSimilar(entries, { threshold: 0.85 });
  const merged = r.keep.find((e) => e.mergedFrom);
  assert.ok(merged, '应合并');
  assert.equal(merged.mergedFrom, 2);
  assert.equal(merged.recordedAt, '2026-10-01T10:00:00Z', '取最早 recordedAt');
  assert.equal(merged.src, 'private');
  assert.equal(merged.embedModel, 'bge-m3@1024');
});
