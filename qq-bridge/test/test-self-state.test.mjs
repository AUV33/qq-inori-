import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFECT_KEYS, SELF_STATE_VERSION,
  createSelfState, normalizeSelfState, tickSelfState, applyAppraisal, applyEvent,
  needsPressure, summarizeSelfState, snapshotSelfState, restoreSelfState,
} from '../src/domain/mind/self-state.mjs';

const H = 3600 * 1000;

function bounded(s) {
  for (const key of ['energy', 'sleepDebt', 'socialHunger', 'curiosity', 'competence', 'stress', 'valence', 'arousal', 'mood']) {
    assert.ok(Number.isFinite(s[key]), key + ' finite');
    assert.ok(s[key] >= 0 && s[key] <= 1, key + ' bounded: ' + s[key]);
  }
  for (const key of AFFECT_KEYS) {
    assert.ok(Number.isFinite(s.affect[key]), key + ' finite');
    assert.ok(s.affect[key] >= 0 && s.affect[key] <= 1, key + ' bounded: ' + s.affect[key]);
  }
}

test('createSelfState：默认值有界，版本正确', () => {
  const s = createSelfState({ at: 1000 });
  assert.equal(s.v, SELF_STATE_VERSION);
  assert.equal(s.at, 1000);
  bounded(s);
});

test('normalizeSelfState：垃圾输入不产生 NaN，越界被夹紧', () => {
  const s = normalizeSelfState({ energy: 9, stress: -3, affect: { joy: 'x', anger: 2 }, evidence: [null, { at: 1 }] });
  bounded(s);
  assert.equal(s.energy, 1);
  assert.equal(s.stress, 0);
  assert.equal(s.affect.joy, 0);
  assert.equal(s.affect.anger, 1);
  assert.equal(s.evidence.length, 1);
});

test('tickSelfState：情绪 6h 半衰', () => {
  const s = createSelfState({ at: 0, affect: { joy: 0.8 } });
  const after = tickSelfState(s, { now: 6 * H });
  assert.ok(Math.abs(after.affect.joy - 0.4) < 0.01, 'joy ~0.4, got ' + after.affect.joy);
  bounded(after);
});

test('tickSelfState：醒着耗精力、睡眠恢复；dt=0 不变', () => {
  const s = createSelfState({ at: 0, energy: 0.9, sleepDebt: 0.5 });
  const same = tickSelfState(s, { now: 0 });
  assert.equal(same.energy, 0.9);
  const awake = tickSelfState(s, { now: 9 * H });
  assert.ok(awake.energy < 0.9, 'energy should drain');
  assert.ok(awake.sleepDebt >= 0.5, 'sleep debt should not drop while awake');
  const slept = tickSelfState(s, { now: 6 * H, sleeping: true });
  assert.ok(slept.energy > 0.9, 'energy should recover while sleeping');
  assert.ok(slept.sleepDebt < 0.5, 'sleep debt should recover while sleeping');
  bounded(awake);
  bounded(slept);
});

test('tickSelfState：社交饥饿随时间上升，互动事件降低', () => {
  const s = createSelfState({ at: 0, socialHunger: 0.2 });
  const hungry = tickSelfState(s, { now: 20 * H });
  assert.ok(hungry.socialHunger > 0.2);
  const fed = applyEvent(hungry, { type: 'social', intensity: 1 }, { now: 20 * H + 1 });
  assert.ok(fed.socialHunger < hungry.socialHunger);
  bounded(fed);
});

test('applyAppraisal：单次增量有上限，状态不越界', () => {
  const s = createSelfState({ at: 0 });
  const hot = applyAppraisal(s, { valence: 10, arousal: 10, intensity: 1, emotions: { anger: 10, joy: 10 } }, { now: 1 });
  bounded(hot);
  assert.ok(hot.affect.anger <= 0.25);
  assert.ok(hot.valence <= 0.35);
  assert.equal(s.affect.anger, 0, '原状态不被修改');
});

test('applyEvent：失败降低胜任感，成功提升效价；未识别事件不改数值', () => {
  const s = createSelfState({ at: 0, competence: 0.6, valence: 0.1 });
  const failed = applyEvent(s, { type: 'failure', intensity: 1 }, { now: 1 });
  assert.ok(failed.competence < 0.6);
  const odd = applyEvent(s, { type: 'unknown', intensity: 1 }, { now: 1 });
  assert.equal(odd.competence, 0.6);
  assert.equal(odd.valence, 0.1);
  assert.equal(odd.evidence.length, 1);
});

test('needsPressure：五项缺口都在 0..1；耗尽时 rest 高', () => {
  const tired = createSelfState({ at: 0, energy: 0.05, sleepDebt: 0.9, socialHunger: 0.9, stress: 0.8 });
  const p = needsPressure(tired);
  for (const key of Object.keys(p)) {
    assert.ok(p[key] >= 0 && p[key] <= 1, key);
  }
  assert.ok(p.rest > 0.6);
  assert.ok(p.social > 0.8);
});

test('summarizeSelfState：返回非空短句', () => {
  const s = createSelfState({ energy: 0.2, socialHunger: 0.8, curiosity: 0.7 });
  const line = summarizeSelfState(s);
  assert.ok(typeof line === 'string' && line.length > 0);
  assert.match(line, /累/);
});

test('snapshot/restore：往返一致，版本归一', () => {
  const s = createSelfState({ at: 5, energy: 0.33, affect: { joy: 0.2 } });
  const snap = snapshotSelfState(s);
  snap.v = 999;
  const back = restoreSelfState(snap);
  assert.equal(back.v, SELF_STATE_VERSION);
  assert.equal(back.energy, 0.33);
  assert.equal(back.affect.joy, 0.2);
  assert.deepEqual(snapshotSelfState(back), snapshotSelfState(s));
});
