// test-affect-feedback.test.mjs · 宪章 §5.2：她自己的生活必须让她有情绪。
//
// 判据不是"有 affect 字段"，而是：
//   目标完成/陈旧、好奇查清/丢掉、承诺兑现/食言、被回应、出错 —— 都能小步改动情绪；
//   情绪半衰 6h；无由情绪存在但确定可回放；selfTrust 不被情绪侧写偷偷改（A6）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertEvent } from '../src/kernel/events.mjs';
import {
  INITIAL_STATE, reduce, replay, normalizeState,
  decayAffect, bumpAffect, moodNoise,
} from '../src/kernel/state.mjs';

const T = Date.UTC(2026, 10, 4, 0, 0, 0);
const H = 3600000;
const at = (h) => T + h * H;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} != ${b}`);
const S = normalizeState({ ...INITIAL_STATE, at: T });
const zeroAffect = { joy: 0, sadness: 0, anger: 0, fear: 0, affection: 0 };

test('状态 v3：affect 五维默认 0，边界/未知键/旧状态都安全', () => {
  const s = normalizeState({ ...S, affect: { joy: 2, sadness: -1, anger: 0.5, unknown: 1 } });
  assert.equal(s.v, 3);
  assert.deepEqual(s.affect, { joy: 1, sadness: 0, anger: 0.5, fear: 0, affection: 0 });
  assert.deepEqual(normalizeState({}).affect, zeroAffect);
  assert.equal(decayAffect(null, 0).joy, 0);
  assert.deepEqual(bumpAffect(zeroAffect, { joy: 0.5, nope: 1 }), { ...zeroAffect, joy: 0.5 });
});

test('§5.2 目标：完成让她高兴；陈旧让她低落但状态仍是 active；放下是选择', () => {
  let s = reduce(S, assertEvent('goal.formed', { id: 'g1', text: '查清 ws' }, T));
  s = reduce(s, assertEvent('goal.completed', { id: 'g1' }, at(1)));
  assert.ok(s.affect.joy > 0, '完成目标 → joy');
  assert.ok(s.valence > S.valence, '完成目标 → 效价正向');

  let t = reduce(S, assertEvent('goal.formed', { id: 'g2', text: '学 adb' }, T));
  t = reduce(t, assertEvent('goal.stale', { id: 'g2' }, at(1)));
  assert.equal(t.goals[0].status, 'active', '陈旧不替她撤销');
  assert.ok(t.affect.sadness > 0, '挂太久 → sadness');

  let a = normalizeState({ ...S, stress: 0.5 });
  a = reduce(a, assertEvent('goal.formed', { id: 'g3', text: 'x' }, T));
  a = reduce(a, assertEvent('goal.abandoned', { id: 'g3', reason: '优先级变了' }, at(1)));
  assert.ok(a.stress < 0.5, '主动放下 → 压力减');
  assert.ok(a.affect.sadness > 0, '放下也有一点失落（不是系统审判）');
});

test('§5.2 好奇：查清 → joy；丢掉 → sadness；驱动标量仍独立', () => {
  let s = reduce(S, assertEvent('curiosity.opened', { id: 'q1', text: 'ws 为什么掉线' }, T));
  const before = { curiosity: s.curiosity, joy: s.affect.joy, sadness: s.affect.sadness };
  const resolved = reduce(s, assertEvent('curiosity.closed', { id: 'q1', how: 'resolved' }, at(1)));
  assert.ok(resolved.affect.joy > before.joy);
  assert.ok(resolved.curiosity > before.curiosity, '查清会抬一点好奇驱动');
  const lost = reduce(s, assertEvent('curiosity.closed', { id: 'q1', how: 'lost' }, at(1)));
  assert.ok(lost.affect.sadness > before.sadness);
});

test('§5.4/§5.2 承诺：兑现 → joy；食言 → sadness+anger+stress；都不改 selfTrust', () => {
  let s = reduce(S, assertEvent('commitment.made', { id: 'c1', text: '每天回读账本' }, T));
  const kept = reduce(s, assertEvent('commitment.kept', { id: 'c1' }, at(1)));
  assert.ok(kept.affect.joy > 0);
  assert.equal(kept.selfTrust, 0.5, '兑现不自动改信任');

  const broken = reduce(s, assertEvent('commitment.broken', { id: 'c1', reason: '忘了' }, at(1)));
  assert.ok(broken.affect.sadness > 0);
  assert.ok(broken.affect.anger > 0, '对自己也会有一点火');
  assert.ok(broken.stress > S.stress);
  assert.equal(broken.selfTrust, 0.5, '食言也不自动扣信任（A6）');
});

test('§5.2 社交与出错：被回应 → joy/affection；出错 → anger/fear', () => {
  const heard = reduce(S, assertEvent('message.received', { key: 'private:1' }, T));
  assert.ok(heard.affect.joy > 0);
  assert.ok(heard.affect.affection > 0);

  const errored = reduce(S, assertEvent('error.observed', { source: 'act' }, T));
  assert.ok(errored.affect.anger > 0);
  assert.ok(errored.affect.fear > 0);
  assert.ok(errored.stress > S.stress);
});

test('情绪半衰 6h；不同维独立衰减', () => {
  const base = normalizeState({ ...S, affect: { joy: 0.8, sadness: 0.4, anger: 0, fear: 0, affection: 0 } });
  const decayed = decayAffect(base.affect, 6 * H);
  close(decayed.joy, 0.4, 1e-9);
  close(decayed.sadness, 0.2, 1e-9);
  const viaEvent = reduce(base, assertEvent('life.tick', { at: at(6) }, at(6)));
  close(viaEvent.affect.joy, 0.4, 1e-3);
});

test('§5.13 无由情绪：基线噪声存在、确定可回放、有界', () => {
  assert.equal(moodNoise('seed'), moodNoise('seed'));
  assert.notEqual(moodNoise('seed'), moodNoise('seed', 7));
  for (const seed of ['a', 'b', at(3), 12345]) {
    const n = moodNoise(seed);
    assert.ok(n >= -1 && n <= 1);
  }
  const events = Array.from({ length: 60 }, (_, i) => assertEvent('life.tick', { at: at(i + 1) }, at(i + 1)));
  const run = events.reduce((s, e) => reduce(s, e), normalizeState({ ...S, sleeping: false }));
  const runAgain = events.reduce((s, e) => reduce(s, e), normalizeState({ ...S, sleeping: false }));
  assert.deepEqual(run, runAgain, '噪声必须可回放');
  assert.ok(Math.abs(run.valence) > 1e-9, '基线噪声让效价不必归零（无由情绪）');
  assert.deepEqual(replay(events, normalizeState({ ...S, sleeping: false })), run);
});

test('A6：她自己的信任评估不改情绪（系统不替她解读）', () => {
  const s = reduce(S, assertEvent('self.trust_assessed', { value: 0.2, reason: '最近老食言' }, T));
  assert.equal(s.selfTrust, 0.2);
  assert.deepEqual(s.affect, zeroAffect);
});

test('反思读得到她此刻的感受（不是只数事件）', async () => {
  const { reflect } = await import('../src/kernel/cognition.mjs');
  const state = normalizeState({ ...S, valence: 0.3, mood: 0.2, affect: { joy: 0.4, sadness: 0.1, anger: 0, fear: 0, affection: 0.2 } });
  const r = reflect(state, [], { now: T });
  assert.equal(r.evidence.valence, 0.3);
  assert.equal(r.evidence.mood, 0.2);
  assert.equal(r.evidence.affect.joy, 0.4);
});
