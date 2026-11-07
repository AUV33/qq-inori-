// [AT-SPLIT] 队列修剪单测：焦点被读掉 → 推进，不整队丢弃；全没了才清空
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneSplitQueue } from '../src/domain/conversation/at-split.js';

test('焦点不在未读里但队列还有下一条 → 推进到它', () => {
  const r = pruneSplitQueue([100, 105], [105]);
  assert.deepEqual(r.queue, [105]);
  assert.equal(r.focus, 105);
  assert.equal(r.changed, true);
});

test('整队都还在未读 → 不动', () => {
  const r = pruneSplitQueue([100, 105], [100, 105, 110]);
  assert.deepEqual(r.queue, [100, 105]);
  assert.equal(r.focus, 100);
  assert.equal(r.changed, false);
});

test('整队都被读掉 → 清空', () => {
  const r = pruneSplitQueue([100, 105], [110]);
  assert.deepEqual(r.queue, []);
  assert.equal(r.focus, 0);
  assert.equal(r.changed, true);
});

test('脏数据被过滤（0/负数/非数字）', () => {
  const r = pruneSplitQueue([0, -1, 'x', 105], [105]);
  assert.deepEqual(r.queue, [105]);
});

test('空输入安全', () => {
  assert.deepEqual(pruneSplitQueue(null, null), { queue: [], focus: 0, changed: false });
});
