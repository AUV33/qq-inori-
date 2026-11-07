// control-room-service 的金标：唤醒优先级、逐条回 @ 队列、中控台文本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlRoom } from '../src/domain/social/control-room-service.mjs';

function ctx(overrides = {}) {
  const conversations = new Map();
  const saved = [];
  const wakes = [];
  const logs = [];
  const base = {
    socialV2: { conversations },
    isSessionAllowedInCurrentMode: () => true,
    isConversationBusyV2: () => false,
    buildScenes: (convs, opts) => Object.entries(convs).map(([key]) => ({ key, unread: 1, running: false })),
    isolatedSessions: new Map([['ownlife', 's1']]),
    renderOpsLine: () => 'ops-line',
    turnDispatch: { occupancy: () => 1, stats: () => ({ queued: 2 }) },
    maxConcurrentTurns: () => 4,
    log: (line) => logs.push(line),
    cfg: { socialV2: { atSplit: { enabled: true, maxPerWake: 3, gapMinMs: 20, gapMaxMs: 20 } } },
    pruneSplitQueue: (queue, aliveSeqs) => {
      const alive = new Set(aliveSeqs.map(Number));
      const next = queue.filter((s) => alive.has(Number(s)));
      return { queue: next, focus: next[0] ?? 0, changed: next.length !== queue.length };
    },
    isDirectedAtAi: (text) => String(text).includes('@我'),
    saveSocialV2State: () => saved.push(1),
    getSocialV2State: (key) => conversations.get(key),
    sendWakePromptV2: async (key, reason) => wakes.push([key, reason]),
  };
  Object.assign(base, overrides);
  return { svc: createControlRoom(base), conversations, saved, wakes, logs };
}

test('wakePriorityV2：基名+子类型，未知 0', () => {
  const h = ctx();
  assert.equal(h.svc.wakePriorityV2('private'), 100);
  assert.equal(h.svc.wakePriorityV2('keyword:小鲸鱼'), 60);
  assert.equal(h.svc.wakePriorityV2('nope:x'), 0);
  assert.equal(h.svc.wakePriorityV2(''), 0);
});

test('directedUnreadList：只留点她的、有 seq 的、非自己', () => {
  const h = ctx();
  const st = { unread: [
    { seq: 1, text: '@我 在吗', sender: 'a' },
    { seq: 2, text: '普通聊天', sender: 'b' },
    { seq: 3, text: '@我 自己', isSelf: true },
    { seq: 0, text: '@我 无 seq' },
  ] };
  assert.deepEqual(h.svc.directedUnreadList(st).map((x) => x.seq), [1]);
});

test('armAtSplit：开关/非群/不足两条返回 null；足够则建队列', () => {
  const h = ctx();
  assert.equal(h.svc.armAtSplit('group:1', { unread: [] }, 'atMention'), null);
  const disabled = ctx({ cfg: { socialV2: { atSplit: { enabled: false } } } });
  assert.equal(disabled.svc.armAtSplit('group:1', { unread: [] }, 'atMention'), null);
  const st = { unread: [{ seq: 1, text: '@我 a' }, { seq: 2, text: '@我 b' }, { seq: 3, text: '@我 c' }, { seq: 4, text: '@我 d' }] };
  const pick = h.svc.armAtSplit('group:1', st, 'atMention');
  assert.deepEqual(pick.map((x) => x.seq), [2, 3, 4]);
  assert.deepEqual(st.atSplitQueue, [2, 3, 4]);
  assert.equal(st.atSplitFocus, 2);
  assert.equal(h.saved.length, 1);
  // 非 @ 类原因不拆
  assert.equal(h.svc.armAtSplit('group:1', { unread: st.unread }, 'anyMessage'), null);
});

test('armAtSplit：已有队列时先 prune，焦点读完推进', () => {
  const h = ctx();
  const st = { unread: [{ seq: 2, text: '@我 b' }], atSplitQueue: [1, 2], atSplitFocus: 1 };
  assert.equal(h.svc.armAtSplit('group:1', st, 'atMention'), null);
  assert.deepEqual(st.atSplitQueue, [2]);
  assert.equal(st.atSplitFocus, 2);
});

test('scheduleNextAtSplit：没队列不动；没开口两次后放下；有后继则续投', async () => {
  const h = ctx();
  h.svc.scheduleNextAtSplit('group:1');
  const st = { atSplitQueue: [1, 2], atSplitFocus: 1, unread: [{ seq: 1 }, { seq: 2 }] };
  h.conversations.set('group:1', st);
  h.svc.scheduleNextAtSplit('group:1', { replied: false });
  assert.deepEqual(st.atSplitQueue, [1, 2]);
  h.svc.scheduleNextAtSplit('group:1', { replied: false });
  assert.deepEqual(st.atSplitQueue, [2]);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(h.wakes.at(-1), ['group:1', 'atSplit']);
  // 最后一条回完清空
  h.svc.scheduleNextAtSplit('group:1');
  assert.deepEqual(st.atSplitQueue, []);
});

test('controlRoomLineFor：过滤当前/白名单外，返回 ops 行', () => {
  const h = ctx({
    isSessionAllowedInCurrentMode: (k) => k !== 'group:blocked',
  });
  h.conversations.set('group:1', {});
  h.conversations.set('group:blocked', {});
  h.conversations.set('group:current', {});
  assert.equal(h.svc.controlRoomLineFor('group:current'), 'ops-line\n\n');
});
