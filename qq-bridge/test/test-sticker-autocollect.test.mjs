// [AUTO-PACE] 自动收藏节奏闸的回归锁：日/小时额度、跨天跨小时归零、最小间隔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutoCollect, evaluateCaptionRetry } from '../src/domain/send/sticker-autocollect.mjs';

const at = (iso) => Date.parse(iso);
const meta = (o = {}) => ({ autoDay: '2026-10-28', autoCount: 0, autoHourDay: '2026-10-28', autoHour: 0, autoHourCount: 0, lastAutoAt: 0, ...o });

test('额度内放行，并把日/小时计数都 +1、记录 lastAutoAt', () => {
  const now = at('2026-10-28T10:15:00+08:00');
  const r = evaluateAutoCollect({ meta: meta({ autoHour: 10 }), now, maxPerDay: 5, maxPerHour: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.metaPatch.autoCount, 1);
  assert.equal(r.metaPatch.autoHourCount, 1);
  assert.equal(r.metaPatch.lastAutoAt, now);
});

test('日额度用光 → cap（这就是 10/28 白天不再收藏的原因）', () => {
  const now = at('2026-10-28T15:00:00+08:00');
  const r = evaluateAutoCollect({ meta: meta({ autoCount: 5, autoHour: 15 }), now, maxPerDay: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cap');
});

test('同一小时超过小时额度 → hour-cap（防止 12 分钟烧光 5 张）', () => {
  const now = at('2026-10-28T00:20:00+08:00');
  const r = evaluateAutoCollect({ meta: meta({ autoCount: 2, autoHour: 0, autoHourCount: 2 }), now, maxPerDay: 5, maxPerHour: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hour-cap');
});

test('最小间隔内 → paced，并给出还要等多久', () => {
  const now = at('2026-10-28T10:20:00+08:00');
  const last = now - 5 * 60 * 1000;
  const r = evaluateAutoCollect({ meta: meta({ autoHour: 10, lastAutoAt: last }), now, minIntervalMs: 30 * 60 * 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'paced');
  assert.ok(r.waitMs > 0);
});

test('跨天：日计数归零；跨小时：小时计数归零（即使元数据是昨天的）', () => {
  const nextDay = at('2026-10-29T09:00:00+08:00');
  const r1 = evaluateAutoCollect({ meta: meta({ autoDay: '2026-10-28', autoCount: 5, autoHour: 23, autoHourCount: 2 }), now: nextDay, maxPerDay: 5, maxPerHour: 2 });
  assert.equal(r1.ok, true, '新的一天额度重置');
  assert.equal(r1.metaPatch.autoCount, 1);
  assert.equal(r1.metaPatch.autoHourCount, 1);

  const sameDayNewHour = at('2026-10-28T11:00:00+08:00');
  const r2 = evaluateAutoCollect({ meta: meta({ autoCount: 3, autoHour: 10, autoHourCount: 2 }), now: sameDayNewHour, maxPerDay: 5, maxPerHour: 2 });
  assert.equal(r2.ok, true, '新的一小时小时额度重置');
  assert.equal(r2.metaPatch.autoCount, 4);
  assert.equal(r2.metaPatch.autoHourCount, 1);
});

test('间隔 0 不拦截；lastAutoAt 缺失也不拦截', () => {
  const now = at('2026-10-28T10:00:00+08:00');
  assert.equal(evaluateAutoCollect({ meta: meta({ autoHour: 10 }), now, minIntervalMs: 0 }).ok, true);
  assert.equal(evaluateAutoCollect({ meta: meta({ autoHour: 10, lastAutoAt: 0 }), now, minIntervalMs: 3600000 }).ok, true);
});

// [CAPTION-BACKOFF] 打标失败不是无限重试：指数退避，3 次后跳过。
test('打标重试：首次放行；失败后按 30min 指数退避；3 次后跳过', () => {
  const t0 = at('2026-10-30T10:00:00+08:00');
  assert.equal(evaluateCaptionRetry({}, { now: t0 }).ok, true);
  const firstFail = { captionAttempts: 1, captionFailedAt: t0 };
  assert.equal(evaluateCaptionRetry(firstFail, { now: t0 + 29 * 60000 }).ok, false);
  assert.equal(evaluateCaptionRetry(firstFail, { now: t0 + 30 * 60000 }).ok, true);
  const secondFail = { captionAttempts: 2, captionFailedAt: t0 };
  assert.equal(evaluateCaptionRetry(secondFail, { now: t0 + 59 * 60000 }).ok, false);
  assert.equal(evaluateCaptionRetry(secondFail, { now: t0 + 60 * 60000 }).ok, true);
  assert.equal(evaluateCaptionRetry({ captionAttempts: 3, captionFailedAt: t0 }, { now: t0 + 10 * 3600000 }).skip, true);
  assert.equal(evaluateCaptionRetry({ captionSkipped: true }, { now: t0 + 10 * 3600000 }).skip, true);
});
