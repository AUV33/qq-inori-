import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BELIEF_VERSION, createBeliefStore, normalizeBeliefStore, getPerson, getGroup,
  observePerson, decayBeliefs, relationshipWeight, openLoopsOf, closeOpenLoop,
  observeGroup, safePersonView, snapshotBeliefStore, restoreBeliefStore,
} from '../src/domain/mind/belief-store.mjs';

const D = 24 * 3600 * 1000;
const NOW = 1793713000000;

function bounded(p) {
  for (const key of ['trust', 'affinity', 'reliability', 'familiarity']) {
    assert.ok(Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1, key + ': ' + p[key]);
  }
}

test('create/get：未知人返回中性默认值', () => {
  const store = createBeliefStore({ now: NOW });
  assert.equal(store.v, BELIEF_VERSION);
  const p = getPerson(store, 'user:404', { now: NOW });
  assert.equal(p.trust, 0.5);
  assert.equal(p.affinity, 0.5);
  assert.equal(p.familiarity, 0);
  bounded(p);
});

test('observePerson：正向互动提高信任/亲近，单次有上限', () => {
  let store = createBeliefStore({ now: NOW });
  const before = getPerson(store, 'u1', { now: NOW });
  store = observePerson(store, 'u1', { valence: 1, reliability: 1, intensity: 1 }, { now: NOW + 1000 });
  const after = getPerson(store, 'u1', { now: NOW + 1000 });
  assert.ok(after.trust > before.trust);
  assert.ok(after.affinity > before.affinity);
  assert.ok(after.trust - before.trust <= 0.08 + 1e-9);
  assert.ok(after.affinity - before.affinity <= 0.12 + 1e-9);
  assert.equal(after.interactionCount, 1);
  bounded(after);
});

test('observePerson：负向互动降低亲近，但不越界', () => {
  let store = createBeliefStore({ now: NOW });
  store = observePerson(store, 'u1', { valence: -1, reliability: 1, intensity: 1 }, { now: NOW + 1 });
  const p = getPerson(store, 'u1', { now: NOW + 1 });
  assert.ok(p.affinity < 0.5);
  assert.ok(p.trust < 0.5);
  bounded(p);
});

test('familiarity：多次互动后趋于饱和但不超过 1', () => {
  let store = createBeliefStore({ now: NOW });
  for (let i = 0; i < 200; i += 1) {
    store = observePerson(store, 'u1', { valence: 0, reliability: 0.5, intensity: 1 }, { now: NOW + i + 1 });
  }
  const p = getPerson(store, 'u1', { now: NOW + 200 });
  assert.ok(p.familiarity > 0.9 && p.familiarity <= 1);
  assert.equal(p.interactionCount, 200);
});

test('topics：累积、衰减、上限', () => {
  let store = createBeliefStore({ now: NOW });
  store = observePerson(store, 'u1', { topics: ['钓鱼', '猫'] }, { now: NOW + 1 });
  let p = getPerson(store, 'u1', { now: NOW + 1 });
  assert.ok(p.topics['钓鱼'] > 0);
  assert.ok(p.topics['猫'] > 0);
  const before = p.topics['钓鱼'];
  store = decayBeliefs(store, { now: NOW + 31 * D });
  p = getPerson(store, 'u1', { now: NOW + 31 * D });
  assert.ok(p.topics['钓鱼'] < before);
});

test('openLoops：添加、去重、关闭、带年龄', () => {
  let store = createBeliefStore({ now: NOW });
  store = observePerson(store, 'u1', { openLoop: { topic: '帮她查显卡驱动', urgency: 0.8 } }, { now: NOW });
  store = observePerson(store, 'u1', { openLoop: { topic: '帮她查显卡驱动' } }, { now: NOW + 1000 });
  let loops = openLoopsOf(store, 'u1', { now: NOW + 2 * D });
  assert.equal(loops.filter((l) => l.status === 'open').length, 1);
  assert.ok(Math.abs(loops[0].ageDays - 2) < 0.01);
  store = closeOpenLoop(store, 'u1', { topic: '帮她查显卡驱动' }, { now: NOW + 3 * D });
  loops = openLoopsOf(store, 'u1', { now: NOW + 3 * D });
  assert.equal(loops.length, 0);
});

test('decayBeliefs：30 天后向中性回归，熟悉度下降', () => {
  let store = createBeliefStore({ now: NOW });
  for (let i = 0; i < 20; i += 1) store = observePerson(store, 'u1', { valence: 1 }, { now: NOW + i });
  const before = getPerson(store, 'u1', { now: NOW + 20 });
  store = decayBeliefs(store, { now: NOW + 20 + 30 * D });
  const after = getPerson(store, 'u1', { now: NOW + 20 + 30 * D });
  assert.ok(after.trust < before.trust);
  assert.ok(after.affinity < before.affinity);
  assert.ok(after.familiarity < before.familiarity);
  bounded(after);
});

test('relationshipWeight：有界且随互动变化', () => {
  let store = createBeliefStore({ now: NOW });
  const neutral = getPerson(store, 'u1', { now: NOW });
  const w0 = relationshipWeight(neutral);
  store = observePerson(store, 'u1', { valence: 1, reliability: 1 }, { now: NOW + 1 });
  const w1 = relationshipWeight(getPerson(store, 'u1', { now: NOW + 1 }));
  assert.ok(w1 > w0);
  assert.ok(w0 >= 0 && w0 <= 1 && w1 >= 0 && w1 <= 1);
});

test('safePersonView：群上下文不泄露边界与证据', () => {
  let store = createBeliefStore({ now: NOW });
  store = observePerson(store, 'u1', { boundary: '不谈家人病史', openLoop: '下次面试' }, { now: NOW + 1 });
  const view = safePersonView(getPerson(store, 'u1', { now: NOW + 1 }));
  assert.equal(view.boundaries, undefined);
  assert.equal(view.evidence, undefined);
  assert.equal(view.openLoops.length, 1);
});

test('observeGroup：群信念有界，norm 去重', () => {
  let store = createBeliefStore({ now: NOW });
  store = observeGroup(store, 'g1', { acceptance: 0.9, mood: 0.2, norms: ['不要刷屏', '不要刷屏'], topics: ['钓鱼'] }, { now: NOW + 1 });
  const g = getGroup(store, 'g1', { now: NOW + 1 });
  assert.ok(g.acceptance > 0.5);
  assert.ok(g.mood < 0.5);
  assert.deepEqual(g.norms, ['不要刷屏']);
  assert.ok(g.topics['钓鱼'] > 0);
});

test('垃圾输入：不产生 NaN，结构归一', () => {
  const store = normalizeBeliefStore({ people: { u1: { trust: 'x', affinity: 5, topics: { a: 'y' }, evidence: [null, {}] } }, groups: null });
  const p = getPerson(store, 'u1', { now: NOW });
  bounded(p);
  assert.equal(p.trust, 0);
  assert.equal(p.affinity, 1);
  assert.equal(p.topics.a, 0);
});

test('snapshot/restore：往返一致', () => {
  let store = createBeliefStore({ now: NOW });
  store = observePerson(store, 'u1', { valence: 0.8, topics: ['猫'] }, { now: NOW + 5 });
  const snap = snapshotBeliefStore(store);
  const back = restoreBeliefStore(snap);
  assert.deepEqual(snapshotBeliefStore(back), snap);
});
