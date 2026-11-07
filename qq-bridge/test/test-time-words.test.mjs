// [TIME-WORDS] 时间说人话的回归锁
import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeGap, humanizeDuration, humanizeAgo, humanizeAge } from '../src/domain/conversation/time-words.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('humanizeGap：从刚刚到天', () => {
  assert.equal(humanizeGap(20_000), '刚刚');
  assert.equal(humanizeGap(5 * MIN), '5 分钟前');
  assert.equal(humanizeGap(2 * HOUR), '2 小时前');
  assert.equal(humanizeGap(25 * HOUR), '昨天');
  assert.equal(humanizeGap(49 * HOUR), '前天');
  assert.equal(humanizeGap(5 * DAY), '5 天前');
});

test('humanizeGap：隔夜不会再写成 720 分钟', () => {
  const g = humanizeGap(12 * HOUR);
  assert.equal(g, '12 小时前');
  assert.ok(!g.includes('分钟'));
});

test('humanizeGap：非法输入返回空串', () => {
  assert.equal(humanizeGap(-1), '');
  assert.equal(humanizeGap(NaN), '');
  assert.equal(humanizeGap(undefined), '');
});

test('humanizeDuration：持续态（闲了 X / 睡了 X）', () => {
  assert.equal(humanizeDuration(30_000), '刚刚');
  assert.equal(humanizeDuration(30 * MIN), '30 分钟');
  assert.equal(humanizeDuration(3 * HOUR), '3 小时');
  assert.equal(humanizeDuration(2 * DAY), '2 天');
});

test('humanizeAgo：时间戳换算，无效时间戳返回空串', () => {
  const now = Date.UTC(2026, 9, 29, 0, 0, 0);
  assert.equal(humanizeAgo(now - 90 * MIN, now), '1 小时前');
  assert.equal(humanizeAgo(0, now), '');
  assert.equal(humanizeAgo('坏值', now), '');
});

test('humanizeAge：挂心多久', () => {
  assert.equal(humanizeAge(2 * HOUR), '今天挂上的');
  assert.equal(humanizeAge(DAY), '挂了 1 天');
  assert.equal(humanizeAge(10 * DAY), '挂了 10 天');
});
