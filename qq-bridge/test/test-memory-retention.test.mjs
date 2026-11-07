import test from 'node:test';
import assert from 'node:assert/strict';

import { retentionScore, isProtected, partitionForRetention } from '../src/domain/memory/memory-retention.mjs';

const DAY = 86400000;
const NOW = 1793772000000;
const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

test('retentionScore：重要/时近/被回忆更高；0..1 有界', () => {
  const hot = retentionScore({ importance: 5, day: day(0), mentions: 10 }, { now: NOW });
  const cold = retentionScore({ importance: 1, day: day(300), mentions: 0 }, { now: NOW });
  assert.ok(hot > cold);
  assert.ok(hot <= 1 && cold >= 0);
  assert.equal(retentionScore(null), 0);
});

test('isProtected：她自己写的/重要≥4/pinned/fact 都保护', () => {
  assert.equal(isProtected({ src: 'her' }), true);
  assert.equal(isProtected({ importance: 4 }), true);
  assert.equal(isProtected({ pinned: true }), true);
  assert.equal(isProtected({ kind: 'fact' }), true);
  assert.equal(isProtected({ importance: 2, kind: 'group-digest' }), false);
});

test('未超上限：全保留，不归档', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ text: 't' + i, importance: 2 }));
  const r = partitionForRetention(entries, { now: NOW, maxEntries: 100 });
  assert.equal(r.keep.length, 10);
  assert.equal(r.archive.length, 0);
});

test('超上限：先移出分数最低的非保护条目；保护条目永不归档', () => {
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => ({ text: 'old' + i, importance: 1, day: day(500 - i) })),
    { text: 'important', importance: 5, day: day(500) },
    { text: 'her', src: 'her', importance: 1, day: day(500) },
  ];
  const r = partitionForRetention(entries, { now: NOW, maxEntries: 5 });
  assert.equal(r.keep.length + r.archive.length, 10, '不丢条目（只移出）');
  assert.equal(r.archive.length, 5);
  assert.ok(r.keep.some((e) => e.text === 'important'));
  assert.ok(r.keep.some((e) => e.text === 'her'));
  assert.ok(!r.archive.some((e) => e.text === 'important' || e.text === 'her'));
});

test('确定性：同输入同结果', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ text: 't' + i, importance: (i % 5) + 1, day: day(i) }));
  const a = partitionForRetention(entries, { now: NOW, maxEntries: 10 });
  const b = partitionForRetention(entries, { now: NOW, maxEntries: 10 });
  assert.deepEqual(a.archive.map((e) => e.text), b.archive.map((e) => e.text));
});
