// inori-momentum 金标：非线性动量、14 天回落、检索打分权重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentumOf, bump, rankScore, rankScoreV2, normalizeImportance, V2_WEIGHTS, K, DECAY_DAYS, DECAY_FACTOR } from '../src/domain/leaves/inori-momentum.js';

const DAY = 86400000;
const NOW = 1_800_000_000_000;

test('momentumOf：提 1 次 0.181、提 3 次 0.451、提 10 次 0.865（越往后涨得越慢）', () => {
  assert.equal(momentumOf({ mentions: 1 }), Number((1 - Math.exp(-1 / K)).toFixed(3)));
  assert.equal(momentumOf({ mentions: 3 }), 0.451);
  assert.equal(momentumOf({ mentions: 10 }), 0.865);
  const m3 = momentumOf({ mentions: 3 });
  const m6 = momentumOf({ mentions: 6 });
  assert.ok(m6 - m3 < m3, '增量递减，不是线性膨胀');
});

test('momentumOf：没提过/脏值都是 0', () => {
  assert.equal(momentumOf({}), 0);
  assert.equal(momentumOf(null), 0);
  assert.equal(momentumOf({ mentions: -3 }), 0);
  assert.equal(momentumOf({ mentions: 'abc' }), 0);
});

test('momentumOf：超过 14 天没提到，每个周期 ×0.8 回落', () => {
  const base = momentumOf({ mentions: 10, lastMentionAt: NOW }, NOW);
  const onePeriod = momentumOf({ mentions: 10, lastMentionAt: NOW - 15 * DAY }, NOW);
  const twoPeriods = momentumOf({ mentions: 10, lastMentionAt: NOW - 29 * DAY }, NOW);
  assert.ok(onePeriod < base);
  assert.ok(Math.abs(onePeriod - Number((base * DECAY_FACTOR).toFixed(3))) < 0.002);
  assert.ok(Math.abs(twoPeriods - Number((base * DECAY_FACTOR * DECAY_FACTOR).toFixed(3))) < 0.004);
});

test('momentumOf：刚好 14 天整数倍时按已过周期数打折（floor 语义）', () => {
  const at = momentumOf({ mentions: 10, lastMentionAt: NOW - DECAY_DAYS * DAY }, NOW);
  const justBefore = momentumOf({ mentions: 10, lastMentionAt: NOW - (DECAY_DAYS * DAY - 60000) }, NOW);
  assert.ok(at < justBefore, '满 14 天才打折');
});

test('momentumOf：没有 lastMentionAt 时回落到 at；都没有就不打折', () => {
  const noTimes = momentumOf({ mentions: 10 });
  assert.equal(noTimes, 0.865);
  const withAt = momentumOf({ mentions: 10, at: NOW - 30 * DAY }, NOW);
  assert.ok(withAt < noTimes, '用 at 也能算活跃度');
});

test('bump：mentions+1、刷新 lastMentionAt、顺手写回 momentum', () => {
  const entry = { mentions: 2 };
  bump(entry, NOW);
  assert.equal(entry.mentions, 3);
  assert.equal(entry.lastMentionAt, NOW);
  assert.equal(entry.momentum, momentumOf(entry, NOW));
});

test('bump：非对象原样返回（不炸）', () => {
  assert.equal(bump(null), null);
  assert.equal(bump('x'), 'x');
});

test('rankScore：相关性为主、动量为辅、最近说过加成', () => {
  const fresh = rankScore({ similarity: 1, momentum: 1, lastAt: NOW }, NOW);
  assert.equal(fresh, 1);
  const old = rankScore({ similarity: 1, momentum: 1, lastAt: NOW - 100 * DAY }, NOW);
  assert.ok(old < fresh, '很久没提的排后面');
  const noSim = rankScore({ similarity: 0, momentum: 0, lastAt: 0 }, NOW);
  assert.equal(noSim, 0.01, '没时间信息时 rec 给最低档 0.1');
});

test('rankScore：脏值当 0，权重可覆盖', () => {
  assert.equal(rankScore({ similarity: 'x', momentum: null, lastAt: 'y' }, NOW), 0.01);
  const w = { sim: 1, mom: 0, rec: 0 };
  assert.equal(rankScore({ similarity: 0.5, momentum: 0.9, lastAt: NOW }, NOW, w), 0.5);
});

test('rankScoreV2：高相似度压过字面/类型等常数加成（修 B4）', () => {
  const semantic = rankScoreV2({ similarity: 0.9, importance: 2, momentum: 0, lastAt: NOW, boosts: { lexical: 0, kind: 0 } }, NOW);
  const lexical = rankScoreV2({ similarity: 0.2, importance: 5, momentum: 1, lastAt: NOW, boosts: { lexical: 1, kind: 1 } }, NOW);
  assert.ok(semantic > lexical, semantic + ' vs ' + lexical);
});

test('rankScoreV2：0..1 有界；importance 可传 1..5 或 0..1；权重和为 1', () => {
  const sum = Object.values(V2_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  for (const input of [
    { similarity: 5, importance: 9, momentum: 2, lastAt: NOW, boosts: { lexical: 9, kind: -9 } },
    { similarity: -1, importance: -1, momentum: -1, lastAt: 0 },
    { similarity: 0.5, importance: 0.5 },
  ]) {
    const s = rankScoreV2(input, NOW);
    assert.ok(Number.isFinite(s) && s >= 0 && s <= 1, 'score=' + s);
  }
  assert.equal(normalizeImportance(1), 0);
  assert.equal(normalizeImportance(5), 1);
  assert.equal(normalizeImportance(3), 0.5);
  assert.equal(normalizeImportance('x'), 0.5);
});

test('rankScoreV2：时间越久 recency 越低；无时间信息给最低档', () => {
  const fresh = rankScoreV2({ similarity: 0.5, lastAt: NOW }, NOW);
  const old = rankScoreV2({ similarity: 0.5, lastAt: NOW - 100 * DAY }, NOW);
  const none = rankScoreV2({ similarity: 0.5 }, NOW);
  assert.ok(fresh > old);
  assert.ok(none > 0);
});
