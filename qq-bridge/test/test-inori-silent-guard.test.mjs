// inori-silent-guard 金标：连续缺席的软护栏只在「连续≥2 次没开口 + 距离上次说话≥60 分钟 + 没唠叨过 2 次」时出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentGuardLine } from '../src/domain/leaves/inori-silent-guard.js';

const NOW = new Date('2026-11-02T15:00:00+08:00').getTime(); // 白天，不带深夜软化
const NIGHT = new Date('2026-11-02T02:00:00+08:00').getTime();

test('连续没开口 2 次以内不提示', () => {
  assert.equal(silentGuardLine({}, NOW), null);
  assert.equal(silentGuardLine({ silentStreak: 1 }, NOW), null);
  assert.equal(silentGuardLine(null, NOW), null);
});

test('连续 ≥2 次没开口、且距上次说话 ≥60 分钟 → 给一行软提示（带分钟数）', () => {
  const line = silentGuardLine({ silentStreak: 3, lastAiReplyAt: NOW - 90 * 60000 }, NOW);
  assert.ok(line.includes('连续 3 次都没开口'));
  assert.ok(line.includes('已 90 分钟'));
  assert.ok(line.includes('想说句什么也可以'), '只递许可，不下命令');
});

test('60 分钟内还说过话就不催（刚说过话说明这条她不想接）', () => {
  assert.equal(silentGuardLine({ silentStreak: 3, lastAiReplyAt: NOW - 10 * 60000 }, NOW), null);
});

test('本连击里已经提醒过 2 次就不再唠叨', () => {
  assert.equal(silentGuardLine({ silentStreak: 5, silentReminders: 2, lastAiReplyAt: NOW - 120 * 60000 }, NOW), null);
});

test('从没说过话（没有 lastAiReplyAt）也照样提示，只是不带分钟数', () => {
  const line = silentGuardLine({ silentStreak: 2 }, NOW);
  assert.ok(line.includes('连续 2 次都没开口'));
  assert.ok(!line.includes('距你上次说话'));
});

test('深夜/清晨加「这个点安静着也正常」的软化', () => {
  const line = silentGuardLine({ silentStreak: 2, lastAiReplyAt: NIGHT - 90 * 60000 }, NIGHT);
  assert.ok(line.includes('这个点安静着也正常'));
  assert.ok(!line.includes('这个点安静着也正常', line.indexOf('继续静着')), '软化放在句尾附近');
});

test('脏值不造暗示（字符串/负数都当 0）', () => {
  assert.equal(silentGuardLine({ silentStreak: 'abc', lastAiReplyAt: NOW - 999 * 60000 }, NOW), null);
  assert.equal(silentGuardLine({ silentStreak: -5, lastAiReplyAt: NOW - 999 * 60000 }, NOW), null);
});
