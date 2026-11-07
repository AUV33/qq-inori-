// inori-adapt 金标：样本不足不动参数；低回报降到 1、高回报放回 3、中间取 2；日志口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, computeChaseAdapt, describeAdapt } from '../src/domain/leaves/inori-adapt.js';

test('样本不足（<5）不改编参数，只报告', () => {
  const r = computeChaseAdapt(3, 2, 3);
  assert.equal(r.ok, false);
  assert.equal(r.maxPerDay, 3);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'insufficient(3/5)');
});

test('低回报（<30%）→ 每天最多 1 次', () => {
  const r = computeChaseAdapt(10, 9, 3);
  assert.equal(r.ok, true);
  assert.equal(r.replyRate, 0.1);
  assert.equal(r.maxPerDay, 1);
  assert.equal(r.changed, true);
  assert.match(r.reason, /rate=10%\(1\/10\)/);
});

test('高回报（>70%）→ 放回 3 次', () => {
  const r = computeChaseAdapt(10, 2, 1);
  assert.equal(r.replyRate, 0.8);
  assert.equal(r.maxPerDay, 3);
  assert.equal(r.changed, true);
});

test('中间区间 → 2 次（保守）', () => {
  const r = computeChaseAdapt(10, 5, 3);
  assert.equal(r.replyRate, 0.5);
  assert.equal(r.maxPerDay, 2);
  assert.equal(r.changed, true);
});

test('边界：正好 30% 落中间档（不是低档），正好 70% 也落中间档', () => {
  assert.equal(computeChaseAdapt(10, 7, 3).maxPerDay, 2, '30% 不低于 lowRate');
  assert.equal(computeChaseAdapt(10, 3, 3).maxPerDay, 2, '70% 不高于 highRate');
});

test('unanswered 被夹到 [0, count]；count 为负/脏值当 0', () => {
  const over = computeChaseAdapt(6, 99, 3);
  assert.equal(over.replyRate, 0);
  assert.equal(over.maxPerDay, 1);
  const dirty = computeChaseAdapt('abc', 'xyz', 3);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.maxPerDay, 3);
  assert.equal(dirty.replyRate, 0);
});

test('currentMax 非法时按 baseMax 兜底；参数可覆盖', () => {
  const r = computeChaseAdapt(10, 9, 0);
  assert.equal(r.maxPerDay, 1);
  const custom = computeChaseAdapt(10, 5, 3, { lowRate: 0.6, highRate: 0.9, midMax: 2, baseMax: 4 });
  assert.equal(custom.maxPerDay, 1, '50% < lowRate 0.6 → 降档');
  const capped = computeChaseAdapt(10, 1, 3, { baseMax: 2 });
  assert.equal(capped.maxPerDay, 2, '目标值不会超过 baseMax');
});

test('describeAdapt：无数据/样本不足/调整三态的人话', () => {
  assert.equal(describeAdapt(null), '无数据');
  assert.equal(describeAdapt({ ok: false, maxPerDay: 2, reason: 'insufficient(2/5)' }), '样本不足，保持 2（insufficient(2/5)）');
  assert.equal(describeAdapt({ ok: true, replyRate: 0.2, maxPerDay: 1, changed: true, reason: 'rate=20%(2/10)' }),
    '回报率 20% → maxPerDay 调整为 1（rate=20%(2/10)）');
  assert.equal(describeAdapt({ ok: true, replyRate: 0.5, maxPerDay: 2, changed: false, reason: 'rate=50%(5/10)' }),
    '回报率 50% → maxPerDay 保持 2（rate=50%(5/10)）');
});

test('DEFAULTS 就是用户定的口径（5 次 / 30% / 70% / 1-2-3）', () => {
  assert.deepEqual(DEFAULTS, { minSamples: 5, lowRate: 0.3, highRate: 0.7, lowMax: 1, midMax: 2, baseMax: 3 });
});
