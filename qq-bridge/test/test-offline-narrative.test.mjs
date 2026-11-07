import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeOffline } from '../src/domain/mind/offline-narrative.mjs';

const H = 3600 * 1000;
const T = 1793713000000;

test('空事件：给出第一次醒来的短句', () => {
  const r = summarizeOffline([], { now: T });
  assert.match(r.text, /第一次醒来/);
  assert.equal(r.stats.events, 0);
});

test('消息统计：收发数量、会话数、最近会话', () => {
  const events = [
    { type: 'message.received', key: 'group:1', at: T - 5 * H },
    { type: 'message.sent', key: 'group:1', at: T - 4 * H },
    { type: 'message.received', key: 'private:2', at: T - 3 * H },
    { type: 'message.received', key: 'private:2', at: T - 2 * H },
  ];
  const r = summarizeOffline(events, { now: T });
  assert.equal(r.stats.received, 3);
  assert.equal(r.stats.sent, 1);
  assert.equal(r.stats.keys, 2);
  assert.match(r.text, /收到 3 条、发出 1 条/);
  const priv = r.stats.topKeys.find((k) => k.key === '私聊:2');
  assert.equal(priv.count, 2);
  assert.equal(r.stats.topKeys.length, 2);
});

test('睡眠/反思/错误进入叙事', () => {
  const events = [
    { type: 'sleep.started', at: T - 6 * H },
    { type: 'sleep.ended', at: T - 2 * H },
    { type: 'reflection.completed', at: T - H },
    { type: 'error.observed', at: T - 30 * 60 * 1000 },
  ];
  const r = summarizeOffline(events, { now: T });
  assert.equal(r.stats.sleeps, 1);
  assert.equal(r.stats.wakes, 1);
  assert.match(r.text, /睡过 1 次/);
  assert.match(r.text, /反思/);
  assert.match(r.text, /错误/);
});

test('无消息但有待机：给出“离开多久”', () => {
  const events = [
    { type: 'sleep.started', at: T - 10 * H },
    { type: 'sleep.ended', at: T - 8 * H },
  ];
  const r = summarizeOffline(events, { now: T });
  assert.match(r.text, /离开了约 10 小时/);
});

test('文本有上限、确定性', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ type: 'message.received', key: 'group:' + (i % 5), at: T - i * 1000 }));
  const a = summarizeOffline(events, { now: T });
  const b = summarizeOffline(events, { now: T });
  assert.ok(a.text.length <= 360);
  assert.equal(a.text, b.text);
});
