// [PACE] 场景化回复节奏的回归锁：谁在等 → 多快开口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReplyPace, reasonRoot, PACE_DEFAULTS } from '../src/domain/conversation/reply-pace.js';

const ctx = (o) => ({ kind: 'group', reason: 'atMention', hour: 15, energy: 0.5, groupRatePerMin: 1, ...o });

test('reasonRoot 去掉尾巴', () => {
  assert.equal(reasonRoot('aboutSelf:alias'), 'aboutSelf');
  assert.equal(reasonRoot('private@seq1'), 'private@seq1');
});

test('主人私聊被点名：最快', () => {
  const fast = computeReplyPace(ctx({ kind: 'private', reason: 'atMention' }));
  const group = computeReplyPace(ctx({ reason: 'atMention' }));
  assert.equal(fast.scene, 'private-urgent');
  assert.ok(fast.holdMs < group.holdMs, '私聊点名应比群点名快');
  assert.ok(fast.holdMs <= 500);
});

test('群里闲聊比群里被点名慢得多', () => {
  const directed = computeReplyPace(ctx({ reason: 'atMention' }));
  const casual = computeReplyPace(ctx({ reason: 'continueChat' }));
  assert.ok(casual.holdMs >= directed.holdMs * 2);
  assert.equal(casual.scene, 'group-casual');
});

test('凌晨整体放慢，但私聊点名只放慢一点', () => {
  const day = computeReplyPace(ctx({ kind: 'private', reason: 'poke', hour: 15 }));
  const night = computeReplyPace(ctx({ kind: 'private', reason: 'poke', hour: 3 }));
  assert.ok(night.holdMs > day.holdMs);
  const nightGroup = computeReplyPace(ctx({ reason: 'atMention', hour: 3 }));
  assert.ok(nightGroup.factor > computeReplyPace(ctx({ reason: 'atMention', hour: 15 })).factor);
});

test('她睡着了：非点名更慢，私聊点名仍能较快叫醒（×2 不是 ×3）', () => {
  const asleepDirected = computeReplyPace(ctx({ kind: 'private', reason: 'poke', asleep: true }));
  const awakeDirected = computeReplyPace(ctx({ kind: 'private', reason: 'poke', asleep: false }));
  assert.ok(asleepDirected.holdMs > awakeDirected.holdMs);
  const asleepCasual = computeReplyPace(ctx({ reason: 'continueChat', asleep: true }));
  assert.ok(asleepCasual.factor >= computeReplyPace(ctx({ reason: 'continueChat', asleep: false })).factor * 2.9);
});

test('精力低更慢，精力足且被点名更快', () => {
  const low = computeReplyPace(ctx({ reason: 'atMention', energy: 0.1 }));
  const high = computeReplyPace(ctx({ reason: 'atMention', energy: 0.9 }));
  assert.ok(low.holdMs > high.holdMs);
});

test('群很热闹：点名加快，闲聊再慢一点', () => {
  const busyDirected = computeReplyPace(ctx({ reason: 'question', groupRatePerMin: 10 }));
  const calmDirected = computeReplyPace(ctx({ reason: 'question', groupRatePerMin: 1 }));
  assert.ok(busyDirected.holdMs < calmDirected.holdMs);
  const busyCasual = computeReplyPace(ctx({ reason: 'probability', groupRatePerMin: 10 }));
  const calmCasual = computeReplyPace(ctx({ reason: 'probability', groupRatePerMin: 1 }));
  assert.ok(busyCasual.holdMs >= calmCasual.holdMs);
});

test('上下界：因子被夹在 [0.15, 6]，延迟不越界', () => {
  for (const reason of ['private', 'atMention', 'continueChat', 'recovery', 'whatever']) {
    for (const kind of ['private', 'group']) {
      for (const hour of [3, 15]) {
        for (const asleep of [true, false]) {
          const p = computeReplyPace(ctx({ kind, reason, hour, asleep, energy: 0.05 }));
          assert.ok(p.factor >= 0.15 && p.factor <= 6);
          assert.ok(p.holdMs >= PACE_DEFAULTS.minHoldMs && p.holdMs <= PACE_DEFAULTS.maxHoldMs);
          assert.ok(p.debounceMs >= PACE_DEFAULTS.minDebounceMs && p.debounceMs <= PACE_DEFAULTS.maxDebounceMs);
        }
      }
    }
  }
});

test('monotonic sanity：同一场景 factor 越大 hold 越大', () => {
  const a = computeReplyPace(ctx({ reason: 'atMention', energy: 0.9 }));
  const b = computeReplyPace(ctx({ reason: 'continueChat', energy: 0.1, hour: 3, asleep: true }));
  assert.ok(b.factor > a.factor);
  assert.ok(b.holdMs > a.holdMs);
});

// ── [RHYTHM] 她自己刚说了多少：说完要让出回合 ────────────────────────────

test('刚说过话（45s 内）：明显放慢', () => {
  const calm = computeReplyPace(ctx({ reason: 'atMention' }));
  const justSpoke = computeReplyPace(ctx({ reason: 'atMention', recentSendCount: 1, lastSendAgoMs: 20000 }));
  assert.ok(justSpoke.factor >= calm.factor * 2, `应 ×2 以上（实际 ${justSpoke.factor} vs ${calm.factor}）`);
  assert.match(justSpoke.why, /刚说过话/);
});

test('三分钟内已说 3 条以上：再叠一层放慢', () => {
  const one = computeReplyPace(ctx({ reason: 'atMention', recentSendCount: 1, lastSendAgoMs: 100000 }));
  const many = computeReplyPace(ctx({ reason: 'atMention', recentSendCount: 4, lastSendAgoMs: 100000 }));
  assert.ok(many.factor > one.factor, `说得多应更慢（${many.factor} vs ${one.factor}）`);
  assert.match(many.why, /三分钟内已说4条/);
});

test('两分钟内说过：轻度放慢；私聊只轻放，不让主人干等', () => {
  const calm = computeReplyPace(ctx({ reason: 'atMention' }));
  const mid = computeReplyPace(ctx({ reason: 'atMention', recentSendCount: 1, lastSendAgoMs: 90000 }));
  assert.ok(mid.factor > calm.factor);
  const priv = computeReplyPace(ctx({ kind: 'private', reason: 'poke', recentSendCount: 2, lastSendAgoMs: 10000 }));
  const privCalm = computeReplyPace(ctx({ kind: 'private', reason: 'poke' }));
  assert.ok(priv.factor <= privCalm.factor * 1.5, '私聊不该被放得太慢');
});
