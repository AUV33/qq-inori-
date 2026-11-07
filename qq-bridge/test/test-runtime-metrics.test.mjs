import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, conversationMetrics, tokenMetrics, computeMetrics } from '../src/domain/shared/runtime-metrics.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test('percentile：空数组 null，p50/p90 取整索引正确', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 90), 50);
});

test('conversationMetrics：回复延迟、重复率、未读积压', () => {
  const conv = {
    recentMessages: [
      { time: NOW - 10 * MIN, isSelf: false, text: '在吗' },
      { time: NOW - 9 * MIN, isSelf: true, text: '嗯' },
      { time: NOW - 8 * MIN, isSelf: false, text: '帮我看看' },
      { time: NOW - 7 * MIN, isSelf: true, text: '好' },
      { time: NOW - 6 * MIN, isSelf: true, text: '好' }, // 10 分钟内重复
    ],
    wakeTimes: [NOW - 1000, NOW - 2000, NOW - 30 * 3600 * 1000],
    unread: [{ seq: 9 }],
  };
  const m = conversationMetrics(conv, { now: NOW });
  assert.equal(m.incoming, 2);
  assert.equal(m.outgoing, 3);
  assert.equal(m.wakes, 2);
  assert.equal(m.unread, 1);
  assert.equal(m.duplicateSelf, 1);
  assert.ok(m.replyLatencyMs.p50 >= 1 * MIN && m.replyLatencyMs.p50 <= 2 * MIN);
});

test('tokenMetrics：输入/输出/缓存命中率与每轮均值', () => {
  const rows = [
    { k: 'turn', t: NOW - 1000, b: { cacheMiss: 100, cacheHit: 300, cacheWrite: 0, output: 50 } },
    { k: 'turn', t: NOW - 2000, b: { cacheMiss: 100, cacheHit: 100, cacheWrite: 0, output: 50 } },
    { k: 'base', t: NOW - 3000, b: { cacheMiss: 9999 } },
  ];
  const m = tokenMetrics(rows, { now: NOW });
  assert.equal(m.turns, 2);
  assert.equal(m.inputTokens, 600);
  assert.equal(m.outputTokens, 100);
  assert.equal(m.cacheHitRate, 0.667);
  assert.equal(m.avgInputPerTurn, 300);
});

test('computeMetrics：发现 seq 水位不一致、空转唤醒', () => {
  const convs = new Map([
    ['private:1', {
      recentMessages: [],
      wakeTimes: [NOW - 1000, NOW - 2000],
      unread: [],
      lastUnreadSeq: 10,
      lastReadThroughSeq: 12,
    }],
  ]);
  const out = computeMetrics({ conversations: convs, tokenRows: [], now: NOW });
  assert.ok(out.warnings.some((w) => w.includes('超过了 lastUnreadSeq')));
  assert.ok(out.warnings.some((w) => w.includes('空转唤醒')));
  assert.equal(out.totals.conversations, 1);
});
