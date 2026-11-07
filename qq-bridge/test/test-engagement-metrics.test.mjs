import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMissedDirected, classifyDirected } from '../src/domain/mind/engagement-metrics.mjs';

const T = 1793772000000;
const iso = (ms) => new Date(ms).toISOString();

test('directed+wake 且有 sent 回合 → answered；超窗/无回合 → missed', () => {
  const floor = [
    { key: 'group:1', at: iso(T), directed: true, wake: true },
    { key: 'group:1', at: iso(T + 60000), directed: true, wake: true },
    { key: 'private:2', at: iso(T + 120000), directed: true, wake: true },
    { key: 'group:1', at: iso(T + 180000), directed: false, wake: true },
  ];
  const actions = [
    { t: 'turn', key: 'group:1', outcome: 'sent', ts: iso(T + 5000) },
    { t: 'turn', key: 'private:2', outcome: 'sent', ts: iso(T + 120000 + 6 * 60000) },
    { t: 'turn', key: 'group:1', outcome: 'no_action', ts: iso(T + 200000) },
  ];
  const r = computeMissedDirected(floor, actions, { windowMs: 5 * 60000 });
  assert.equal(r.directedWakes, 3);
  assert.equal(r.answered, 1);
  assert.equal(r.missed, 2);
  assert.ok(Math.abs(r.missedRate - 0.667) < 0.01);
});

test('无样本：noData=true，rate 0', () => {
  const r = computeMissedDirected([], []);
  assert.equal(r.noData, true);
  assert.equal(r.missedRate, 0);
  const r2 = computeMissedDirected([{ directed: true, wake: false, key: 'g' }], []);
  assert.equal(r2.directedWakes, 0);
});

test('确定性：同输入同结果', () => {
  const floor = [{ key: 'g', at: iso(T), directed: true, wake: true }];
  const actions = [{ t: 'turn', key: 'g', outcome: 'sent', ts: iso(T + 1000) }];
  assert.deepEqual(computeMissedDirected(floor, actions), computeMissedDirected(floor, actions));
});

test('classifyDirected：sent / turnOther / noTurn 三分类', () => {
  const floor = [
    { key: 'g1', at: iso(T), directed: true, wake: true },
    { key: 'g1', at: iso(T + 600000), directed: true, wake: true },
    { key: 'g1', at: iso(T + 1200000), directed: true, wake: true },
  ];
  const action = [
    { t: 'turn', key: 'g1', outcome: 'sent', ts: iso(T + 1000) },
    { t: 'turn', key: 'g1', outcome: 'no_action', ts: iso(T + 600000 + 1000) },
  ];
  const r = classifyDirected(floor, action);
  assert.equal(r.directedWakes, 3);
  assert.equal(r.sent, 1);
  assert.equal(r.turnOther, 1);
  assert.equal(r.noTurn, 1);
  assert.equal(r.noTurnRate, Number((1 / 3).toFixed(3)));
});

test('seq/promptSeq：已在提示词里出现的行不计入漏接', () => {
  const floor = [
    { key: 'g1', at: iso(T), directed: true, wake: true, seq: 10, promptSeq: 10 },
    { key: 'g1', at: iso(T + 60000), directed: true, wake: true, seq: 11, promptSeq: 10 },
  ];
  const r = classifyDirected(floor, []);
  assert.equal(r.directedWakes, 1, 'seq<=promptSeq 的行跳过');
  assert.equal(r.noTurn, 1);
});
