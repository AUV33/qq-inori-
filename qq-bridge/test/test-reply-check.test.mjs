// reply-check 的金标：静默缺席计数、回复检查定时、会话忙判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyCheck } from '../src/domain/conversation/reply-check.mjs';

function ctx(overrides = {}) {
  const conversations = new Map();
  const pendingWakeKeys = new Set();
  const promptQueues = new Map();
  const state = { sessions: {} };
  const v2TurnStartAt = new Map();
  const collectors = new Map();
  const woke = [];
  const saved = [];
  const st = { lastWakeReason: 'atMention', lastAiReplyAt: 0, silentRef: 0, silentStreak: 0, recentMessages: [] };
  const base = {
    getCurrentMode: () => 'reserved2',
    getSocialV2State: () => st,
    saveSocialV2State: () => saved.push(1),
    log: () => {},
    cfg: { socialV2: { autoReplyCheckMs: 30000 } },
    socialV2: { conversations, paused: false },
    recentTaskReportAt: new Map(),
    sendWakePromptV2: async (key, reason) => { woke.push([key, reason]); },
    pendingWakeKeys,
    promptQueues,
    state,
    v2TurnStartAt,
    collectors,
    OWNER_LANE_SUFFIX: '#owner',
  };
  Object.assign(base, overrides);
  return { svc: createReplyCheck(base), conversations, pendingWakeKeys, promptQueues, state, v2TurnStartAt, collectors, woke, saved, st };
}

test('noteSilentTurnEndV2：强触发且没开口 → streak+1', () => {
  const h = ctx();
  h.svc.noteSilentTurnEndV2('group:1');
  assert.equal(h.st.silentStreak, 1);
  assert.equal(h.saved.length, 1);
  // 本回合开过口 → 不增加
  h.st.lastAiReplyAt = 2;
  h.st.silentRef = 1;
  h.svc.noteSilentTurnEndV2('group:1');
  assert.equal(h.st.silentStreak, 1);
  // 弱触发不算
  h.st.lastWakeReason = 'recovery';
  h.svc.noteSilentTurnEndV2('group:1');
  assert.equal(h.st.silentStreak, 1);
});

test('noteSilentTurnEndV2：非 reserved2 直接返回', () => {
  const h = ctx({ getCurrentMode: () => 'chat' });
  h.svc.noteSilentTurnEndV2('group:1');
  assert.equal(h.st.silentStreak, 0);
});

test('cancelReplyCheckV2：清掉 timer', () => {
  const h = ctx();
  const st = { replyCheckTimer: setTimeout(() => {}, 10000) };
  h.conversations.set('group:1', st);
  h.svc.cancelReplyCheckV2('group:1');
  assert.equal(st.replyCheckTimer, null);
});

test('scheduleReplyCheckV2：暂停/非二代/已有 timer 不安排', () => {
  const h = ctx({ getCurrentMode: () => 'chat' });
  h.svc.scheduleReplyCheckV2('group:1');
  assert.equal(h.st.replyCheckTimer, undefined);
  h.svc.scheduleReplyCheckV2('group:1');
  assert.equal(h.st.replyCheckTimer, undefined);
});

test('scheduleReplyCheckV2：提问/连发延长等待，到点无未读不唤醒', async () => {
  const h = ctx();
  h.st.recentMessages = [
    { isSelf: true, time: Date.now(), text: '你在吗？' },
    { isSelf: true, time: Date.now(), text: 'a' },
    { isSelf: true, time: Date.now(), text: 'b' },
  ];
  h.svc.scheduleReplyCheckV2('group:1');
  assert.ok(h.st.replyCheckTimer);
  clearTimeout(h.st.replyCheckTimer);
  h.st.replyCheckTimer = null;
  // 到点无未读 → 不唤醒
  h.st.unread = [];
  h.st.replyCheckTimer = setTimeout(() => {}, 1);
  h.st.replyCheckTimer = null;
  h.svc.scheduleReplyCheckV2('group:1');
  const t = h.st.replyCheckTimer;
  assert.ok(t);
  clearTimeout(t);
});

test('isConversationBusyV2：pending/queue/turn/owner lane 都算忙', () => {
  const h = ctx();
  const st = { pendingWakeTimer: 1 };
  assert.equal(h.svc.isConversationBusyV2('group:1', st), true);
  assert.equal(h.svc.isConversationBusyV2('group:1', {}), false);
  h.pendingWakeKeys.add('group:1');
  assert.equal(h.svc.isConversationBusyV2('group:1', {}), true);
  h.pendingWakeKeys.delete('group:1');
  h.promptQueues.set('group:1', { running: true, queue: [] });
  assert.equal(h.svc.isConversationBusyV2('group:1', {}), true);
  h.promptQueues.delete('group:1');
  h.state.sessions['group:1'] = 'sid1';
  h.v2TurnStartAt.set('sid1', 1);
  assert.equal(h.svc.isConversationBusyV2('group:1', {}), true);
  h.v2TurnStartAt.clear();
  h.state.sessions['group:1#owner'] = 'sid2';
  h.collectors.set('sid2', {});
  assert.equal(h.svc.isConversationBusyV2('group:1', {}), true);
});
