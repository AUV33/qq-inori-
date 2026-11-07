import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrends, emptySeries, toMs, dayKey } from '../src/domain/persona/quality-trends.js';

const NOW = Date.parse('2026-10-27T12:00:00+08:00');

test('emptySeries：含今天、按自然日连续', () => {
  const rows = emptySeries(3, NOW);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.equal(rows[0].memory, 0);
});

test('toMs：日期/ISO/数字都能吃，垃圾返回 null', () => {
  assert.equal(dayKey(toMs('2026-10-25')), '2026-10-25');
  assert.equal(dayKey(toMs('2026-10-25T08:00:00+08:00')), '2026-10-25');
  assert.equal(dayKey(toMs(NOW)), '2026-10-27');
  assert.equal(toMs('不是时间'), null);
  assert.equal(toMs(''), null);
});

test('buildTrends：分桶到对应日期并累加', () => {
  const out = buildTrends({
    memory: ['2026-10-25', '2026-10-25', '2026-10-27'],
    lessonsAdded: ['2026-10-26T10:00:00+08:00'],
    lessonsUsed: ['2026-10-27T09:00:00+08:00', '2026-10-27T10:00:00+08:00'],
  }, { days: 3, now: NOW });
  const byDate = Object.fromEntries(out.series.map((r) => [r.date, r]));
  assert.equal(byDate['2026-10-25'].memory, 2);
  assert.equal(byDate['2026-10-27'].memory, 1);
  assert.equal(byDate['2026-10-26'].lessonsAdded, 1);
  assert.equal(byDate['2026-10-27'].lessonsUsed, 2);
  assert.equal(out.totals.memory, 3);
  assert.equal(out.totals.lessonsUsed, 2);
});

test('buildTrends：窗口外与坏值计入 skipped，不静默丢', () => {
  const out = buildTrends({
    memory: ['2026-01-01', 'bad-value'],
    cognitionAdded: ['2026-10-27T11:00:00+08:00'],
  }, { days: 7, now: NOW });
  assert.equal(out.totals.memory, 0);
  assert.equal(out.skipped.memory, 2);
  assert.equal(out.totals.cognitionAdded, 1);
});

test('buildTrends：未知来源不会污染序列', () => {
  const out = buildTrends({ nope: [NOW] }, { days: 2, now: NOW });
  assert.deepEqual(Object.keys(out.series[0]).sort(), ['cognitionAdded', 'date', 'lessonsAdded', 'lessonsUsed', 'memory', 'skillsUsed']);
});
