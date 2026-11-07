import test from 'node:test';
import assert from 'node:assert/strict';

import { selectIntention, planFor, DEFAULT_POLICY } from '../src/domain/mind/meta-controller.mjs';

const NOW = 1793713000000;
const H = 3600 * 1000;

function ctx(over = {}) {
  return {
    v: 1, key: 'private:1', scene: 'private', at: NOW,
    self: { energy: 0.7, sleepDebt: 0.1, socialHunger: 0.2, curiosity: 0.4, stress: 0.1, ...(over.self || {}) },
    belief: { id: 'private:1', trust: 0.6, affinity: 0.6, familiarity: 0.5, lastContactAt: NOW - 2 * H, openLoops: [], ...(over.belief || {}) },
  };
}

test('被直接叫到：reply 胜出', () => {
  const r = selectIntention(ctx(), { now: NOW, directed: true });
  assert.equal(r.selected.type, 'reply');
  assert.ok(r.selected.value >= DEFAULT_POLICY.threshold);
});

test('精力见底且没人叫：rest 胜出', () => {
  const r = selectIntention(ctx({ self: { energy: 0.08, sleepDebt: 0.8 } }), { now: NOW });
  assert.equal(r.selected.type, 'rest');
});

test('社交饥饿 + 久未联系：initiate 可胜出（价值高于阈值）', () => {
  const r = selectIntention(ctx({ self: { socialHunger: 0.95 }, belief: { lastContactAt: NOW - 48 * H } }), { now: NOW });
  assert.ok(r.candidates.some((c) => c.type === 'initiate'));
  assert.equal(r.selected.type, 'initiate');
});

test('没有驱动：selected=null 且有原因', () => {
  const r = selectIntention(ctx({ self: { energy: 0.8, socialHunger: 0.1, curiosity: 0.1, stress: 0 } , belief: { lastContactAt: NOW } }), { now: NOW });
  assert.equal(r.selected, null);
  assert.ok(r.reason.length > 0);
});

test('主人否决：一律不选', () => {
  const r = selectIntention(ctx(), { now: NOW, directed: true, ownerVeto: true });
  assert.equal(r.selected, null);
  assert.equal(r.reason, '主人否决');
});

test('冷却：initiate 在冷却中不能选', () => {
  const r = selectIntention(ctx({ self: { socialHunger: 0.95 }, belief: { lastContactAt: NOW - 48 * H } }), {
    now: NOW,
    cooldowns: { initiate: { lastAt: NOW - 5 * 60 * 1000 } },
  });
  assert.notEqual(r.selected?.type, 'initiate');
  assert.ok(r.blocked.some((b) => b.type === 'initiate' && b.why === 'cooldown'));
});

test('确定性：同输入同结果；value 有界', () => {
  const a = selectIntention(ctx(), { now: NOW, directed: true });
  const b = selectIntention(ctx(), { now: NOW, directed: true });
  assert.deepEqual(a.selected, b.selected);
  for (const c of a.candidates) {
    assert.ok(Number.isFinite(c.value));
    assert.ok(c.value <= 1 && c.value >= -1);
  }
});

test('planFor：意图到语义步骤', () => {
  assert.deepEqual(planFor({ type: 'reply', scene: 'private' }), [{ action: 'respond', scene: 'private', target: '' }]);
  assert.deepEqual(planFor({ type: 'rest' }), [{ action: 'rest' }]);
  assert.deepEqual(planFor({ type: 'nope' }), []);
  assert.deepEqual(planFor(null), []);
});

test('夜里：reflect/consolidate 候选出现（不一定是赢家）', () => {
  const r = selectIntention(ctx({ self: { energy: 0.9 } }), { now: NOW, night: true });
  assert.ok(r.candidates.some((c) => c.type === 'reflect'));
  assert.ok(r.candidates.some((c) => c.type === 'consolidate'));
});
