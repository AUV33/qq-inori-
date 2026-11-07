// 验证 mapSelfStateToKernel：best-effort 映射、未知字段回退、clamp、curiosity 归一。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSelfStateToKernel, seedFromOldSystem } from '../src/kernel/seed-from-oldstate.mjs';

test('映射真实字段且 clamp 到 [0,1]', () => {
  const s = mapSelfStateToKernel({
    self: { energy: 0.4, socialHunger: 0.6, stress: 0.2 },
    mood: { energy: 0.7, warmth: 0.8 },
    curiosity: 10,
    sleeping: false,
  });
  assert.equal(s.energy, 0.4);
  assert.equal(s.socialHunger, 0.6);
  assert.equal(s.stress, 0.2);
  assert.equal(s.valence, 0.8);                 // warmth
  assert.ok(Math.abs(s.mood - 0.75) < 1e-9);    // (0.8+0.7)/2
  assert.equal(s.curiosity, 0.2);               // 10/50
  assert.equal(s.sleeping, false);
  assert.equal(s.sleepDebt, 0.1);
});

test('睡眠态近似 sleepDebt=0.7（顶层 sleeping）', () => {
  const s = mapSelfStateToKernel({ self: {}, mood: {}, sleeping: true });
  assert.equal(s.sleeping, true);
  assert.equal(s.sleepDebt, 0.7);
});

test('sleeping 也接受 selfState.sleeping（真实运行时来源）', () => {
  const s = mapSelfStateToKernel({ self: { sleeping: true, energy: 0.5 }, mood: {} });
  assert.equal(s.sleeping, true);
  assert.equal(s.sleepDebt, 0.7);
});

test('兼容旧拼写 hunger（回退到 socialHunger）', () => {
  const s = mapSelfStateToKernel({ self: { hunger: 0.6 }, mood: {} });
  assert.equal(s.socialHunger, 0.6);
});

test('未知/缺失字段回退默认、不抛错', () => {
  const s = mapSelfStateToKernel();
  assert.equal(s.energy, 0.6);
  assert.equal(s.socialHunger, 0.3);
  assert.equal(s.stress, 0.1);
  assert.equal(s.valence, 0.5);
  assert.equal(s.sleepDebt, 0.1);
});

test('越界数值被 clamp', () => {
  const s = mapSelfStateToKernel({ self: { energy: 5, hunger: -3 }, mood: { warmth: 9 } });
  assert.equal(s.energy, 1);
  assert.equal(s.socialHunger, 0);
  assert.equal(s.valence, 1);
});

test('seedFromOldSystem 容错：loadMoodState 抛错时仍返回默认映射', () => {
  const s = seedFromOldSystem({
    loadMoodState: () => { throw new Error('boom'); },
    selfState: { energy: 0.42 },
    curiosityCount: 25,
    sleeping: false,
  });
  assert.equal(s.energy, 0.42);
  assert.equal(s.curiosity, 0.5);   // 25/50
  assert.equal(s.valence, 0.5);     // mood 读失败 → 默认 warmth
});
