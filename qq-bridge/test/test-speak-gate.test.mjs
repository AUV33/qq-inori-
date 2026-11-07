// [W-1/W-3] 开口时机：防抖 + 门闩 —— 回归锁。
//
// 旧行为：收到消息后至少等 10 秒（每回合都如此），等于把她固定在「接话者」的位置。
// 新行为：只等合并连发的 2 秒；有人冲她/她手上有想说的，直接说。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReplyTiming, evaluateSpeakGate, REPLY_DEBOUNCE_MS } from '../src/domain/conversation/speak-gate.mjs';

test('默认防抖是 2 秒，不是 10 秒', () => {
  assert.equal(REPLY_DEBOUNCE_MS, 2000);
  const t = computeReplyTiming({ now: 1_000_000, lastIncomingAt: 1_000_000 });
  assert.equal(t.quietMs, 2000);
  assert.equal(t.remainingQuietMs, 2000);
});

test('刚收到消息：还剩 2 秒；已经过 1.5 秒：只剩 0.5 秒', () => {
  const a = computeReplyTiming({ now: 10_000, lastIncomingAt: 10_000 });
  assert.equal(a.remainingQuietMs, 2000);
  const b = computeReplyTiming({ now: 11_500, lastIncomingAt: 10_000 });
  assert.equal(b.remainingQuietMs, 500);
});

test('超过防抖窗口：不必再等（remaining=0）', () => {
  const t = computeReplyTiming({ now: 20_000, lastIncomingAt: 10_000 });
  assert.equal(t.remainingQuietMs, 0);
});

test('没有来信 / 坏时间戳：不等', () => {
  assert.equal(computeReplyTiming({ now: 5, lastIncomingAt: 0 }).remainingQuietMs, 0);
  assert.equal(computeReplyTiming({ now: 5, lastIncomingAt: 'x' }).remainingQuietMs, 0);
});

test('可以按配置覆盖防抖时长', () => {
  const t = computeReplyTiming({ now: 10_000, lastIncomingAt: 10_000, debounceMs: 500 });
  assert.equal(t.quietMs, 500);
});

test('有人冲她说话：直接说，不等防抖', () => {
  const g = evaluateSpeakGate({ directed: true, quietLeftMs: 2000 });
  assert.equal(g.speak, true);
  assert.equal(g.waitMs, 0);
});

test('她手上有自己的事：也说，不等', () => {
  const g = evaluateSpeakGate({ hasOwnAgenda: true, quietLeftMs: 2000 });
  assert.equal(g.speak, true);
});

test('对方可能还在连发：等这几秒', () => {
  const g = evaluateSpeakGate({ quietLeftMs: 1800 });
  assert.equal(g.speak, false);
  assert.equal(g.waitMs, 1800);
});

test('上一回合还没结束：不说，也不排队', () => {
  const g = evaluateSpeakGate({ busy: true, directed: true });
  assert.equal(g.speak, false);
  assert.equal(g.waitMs, 0);
});

test('没有议程信号时不伪造「我想说」', () => {
  const g = evaluateSpeakGate({ directed: false, hasOwnAgenda: false, quietLeftMs: 0 });
  assert.equal(g.speak, true); // 没有人在连发 → 可以开口
  assert.match(g.reason, /没有人在连发/);
});
