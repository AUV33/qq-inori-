// [CONTROL-ROOM] 中控台的回归锁：她同时处理多个场面时，提示里能看到"都有谁在等、几个回合在跑"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderControlRoom, buildScenes } from '../src/domain/social/control-room.js';

const NOW = 1_700_000_000_000;
const min = (n) => n * 60_000;

const conv = (o = {}) => ({
  unread: [],
  lastIncomingAt: NOW - min(2),
  lastAiReplyAt: NOW - min(1),
  pendingWakeReasons: [],
  ...o,
});
const unread = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1 }));

test('buildScenes：超过 6 小时无动静的会话不出现', () => {
  const scenes = buildScenes({
    'group:1': conv(),
    'group:2': conv({ lastIncomingAt: NOW - 7 * 60 * min(1), lastAiReplyAt: NOW - 7 * 60 * min(1) }),
  }, { now: NOW });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, '1');
});

test('buildScenes：有未读/在跑的排前面', () => {
  const scenes = buildScenes({
    'group:1': conv({ lastIncomingAt: NOW - min(30) }),
    'group:2': conv({ lastIncomingAt: NOW - min(20) }),
    'private:9': conv({ lastIncomingAt: NOW - min(40), unread: unread(3) }),
  }, { now: NOW, runningKeys: ['group:2'] });
  assert.deepEqual(scenes.slice(0, 2).map((s) => s.id).sort(), ['2', '9']);
});

test('renderControlRoom：列出所有在场场面的未读与最近来信', () => {
  const text = renderControlRoom([
    { id: '222', kind: 'private', unread: 2, lastIncomingAt: NOW - min(1) },
    { id: '656', kind: 'group', unread: 0, lastIncomingAt: NOW - min(9) },
  ], { currentKey: 'private:222', now: NOW, activeTurns: 2, maxTurns: 6 });
  assert.match(text, /私聊 222：2 条没看/);
  assert.match(text, /群 656：静/);
  assert.match(text, /就是这儿/);
  assert.match(text, /回合 2\/6/);
  assert.match(text, /你定/);
});

test('renderControlRoom：后台任务也在视野里', () => {
  const text = renderControlRoom([], { now: NOW, background: ['ownlife', 'reflect'], activeTurns: 3, maxTurns: 6 });
  assert.match(text, /后台在跑：ownlife、reflect/);
  assert.match(text, /回合 3\/6/);
});

test('renderControlRoom：排队数会写出来', () => {
  const text = renderControlRoom([], { now: NOW, activeTurns: 6, maxTurns: 6, queued: 2 });
  assert.match(text, /2 个在排队/);
});

test('renderControlRoom：总长不超过 maxChars', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: String(1000 + i), kind: 'group', unread: 9, lastIncomingAt: NOW - min(i + 1),
  }));
  const text = renderControlRoom(many, { now: NOW, maxChars: 200 });
  assert.ok(text.length <= 200, `实际 ${text.length}`);
});

test('renderControlRoom：完全没有场面时也给一行（不让提示里出现空块）', () => {
  const text = renderControlRoom([], { now: NOW });
  assert.match(text, /我手上同时有这些/);
  assert.match(text, /你定/);
});
