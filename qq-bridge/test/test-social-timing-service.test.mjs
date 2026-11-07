// social-timing-service 的队列/节奏/定时器清理金标。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSocialTiming } from '../src/domain/social/social-timing-service.mjs';

function ctx(overrides = {}) {
  const conversations = new Map();
  const promptQueues = new Map();
  const pendingWakeKeys = new Set(['k']);
  const wakeConfigUpdatedKeys = new Set(['k']);
  const markReadCalledKeys = new Set(['k']);
  const wakeConfigMissCount = new Map([['k', 1]]);
  const messageMediaStore = new Map([['k', new Map()]]);
  const base = {
    cfg: { socialV2: {} },
    log: () => {},
    logAction: () => {},
    fs,
    path,
    stateDataPath: (x) => x,
    sleep: async () => {},
    reverse: new Map(),
    socialV2: { conversations, paused: false },
    promptQueues,
    getSocialV2State: (key) => conversations.get(key),
    saveSocialV2State: () => {},
    appraiseValence: () => 0,
    classifyTopic: () => '',
    computePace: () => ({ factor: 1 }),
    decideMood: () => ({}),
    decideContinue: () => false,
    decideJoin: () => false,
    getLifeState: () => ({}),
    loadGoals: () => [],
    loadMoodState: () => ({}),
    stateWithKey: () => ({}),
    tickMood: () => ({}),
    isDirectedAtAi: () => false,
    loadSlang: () => [],
    findUnknownTerms: () => [],
    loadLessons: () => [],
    loadInterestEncounters: () => ({ items: [] }),
    saveInterestEncounters: () => {},
    recordCuriosity: () => {},
    recordEncounter: () => {},
    markCuriosityStimulus: () => {},
    computeProactivity: () => 0.1,
    sendWakePromptV2: async () => {},
    scheduleWakeWithSecretary: async () => {},
    isConversationBusyV2: () => false,
    isSessionAllowedInCurrentMode: () => true,
    cancelReplyCheckV2: () => {},
    assumeMoreComing: () => ({ wait: false, waitMs: 0 }),
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    messageMediaStore,
  };
  Object.assign(base, overrides);
  return { svc: createSocialTiming(base), conversations, promptQueues, pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, messageMediaStore };
}

test('lastIncomingV2：优先未读，跳过自己', () => {
  const h = ctx();
  const st = { unread: [{ text: 'a', isSelf: false }, { text: 'me', isSelf: true }], recentMessages: [{ text: 'old', isSelf: false }] };
  assert.equal(h.svc.lastIncomingV2(st).text, 'a');
  assert.equal(h.svc.lastIncomingV2({ unread: [], recentMessages: [{ text: 'r', isSelf: false }] }).text, 'r');
  assert.equal(h.svc.lastIncomingV2({ unread: [{ text: 'me', isSelf: true }] }), null);
});

test('paceBatchMs：夹在 800..20000，按 factor 缩放', () => {
  const h = ctx();
  assert.equal(h.svc.paceBatchMs(3000, { factor: 1 }, 'x'), 3000);
  assert.equal(h.svc.paceBatchMs(100, { factor: 1 }, 'x'), 800);
  assert.equal(h.svc.paceBatchMs(30000, { factor: 1 }, 'x'), 20000);
  assert.equal(h.svc.paceBatchMs(1000, { factor: 3 }, 'x'), 3000);
});

test('drainPromptQueue：拒绝队列项并删除；缺失 key 无副作用', () => {
  const h = ctx();
  const seen = [];
  h.promptQueues.set('k', { queue: [{ reject: (e) => seen.push(e.message) }, { reject: (e) => seen.push(e.message) }] });
  h.svc.drainPromptQueue('k', 'boom');
  assert.deepEqual(seen, ['boom', 'boom']);
  assert.equal(h.promptQueues.has('k'), false);
  h.svc.drainPromptQueue('missing', 'x');
});

test('drainAllPromptQueues：清空所有队列', () => {
  const h = ctx();
  const seen = [];
  for (const k of ['a', 'b']) h.promptQueues.set(k, { queue: [{ reject: (e) => seen.push(`${k}:${e.message}`) }] });
  h.svc.drainAllPromptQueues('close');
  assert.deepEqual(seen, ['a:close', 'b:close']);
  assert.equal(h.promptQueues.size, 0);
});

test('clearSocialV2Timers：清 timer 与挂起原因', () => {
  const h = ctx();
  const st = { pendingWakeTimer: setTimeout(() => {}, 10000), sleepTimer: setTimeout(() => {}, 10000), replyCheckTimer: setTimeout(() => {}, 10000), proactiveTimer: setTimeout(() => {}, 10000), pendingWakeReason: 'x', pendingWakeReasons: [1, 2] };
  h.conversations.set('k', st);
  h.svc.clearSocialV2Timers('k');
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(st.sleepTimer, null);
  assert.equal(st.replyCheckTimer, null);
  assert.equal(st.proactiveTimer, null);
  assert.equal(st.pendingWakeReason, null);
  assert.equal(st.pendingWakeReasons.length, 0);
});

test('clearAllSocialV2Timers：清所有会话与全局集合', () => {
  const h = ctx();
  const st = { pendingWakeTimer: setTimeout(() => {}, 10000), pendingWakeReasons: [1] };
  h.conversations.set('k', st);
  h.svc.clearAllSocialV2Timers();
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(h.pendingWakeKeys.size, 0);
  assert.equal(h.wakeConfigUpdatedKeys.size, 0);
  assert.equal(h.markReadCalledKeys.size, 0);
  assert.equal(h.wakeConfigMissCount.size, 0);
  assert.equal(h.messageMediaStore.size, 0);
});

test('插话概率受 SelfState 调节：社交饥饿上调、疲惫/压力下调', () => {
  const seen = [];
  const mk = (self) => ctx({
    getCurrentMode: () => 'reserved2',
    getSelfState: () => self,
    computeProactivity: () => 0.5,
    decideContinue: () => false,
    decideJoin: (o) => { seen.push(o.adaptive); return { ok: false, why: 'test' }; },
  });
  const st = {
    recentMessages: [
      { text: 'a', isSelf: false, time: Date.now() - 60e3 },
      { text: 'b', isSelf: false, time: Date.now() - 50e3 },
      { text: 'c', isSelf: false, time: Date.now() - 40e3 },
    ],
    wakeConfig: { triggers: { probability: 0.3 } },
    lastJoinAt: 0, joinWakeTimes: [], continueWakeTimes: [],
  };
  mk({ socialHunger: 0.9, energy: 0.8, stress: 0 }).svc.maybeJoinOrContinue('group:1', st);
  mk({ socialHunger: 0.1, energy: 0.1, stress: 0.9 }).svc.maybeJoinOrContinue('group:1', st);
  assert.equal(seen.length, 2, '两次都应调用 decideJoin');
  assert.ok(seen[0] > 0.5, '饥饿时 adaptive 上调: ' + seen[0]);
  assert.ok(seen[1] < 0.5, '疲惫/压力时 adaptive 下调: ' + seen[1]);
  assert.ok(seen[0] > seen[1]);
});

test('意志驱动：精力见底时拦截群插话，不安排唤醒', () => {
  const scheduled = [];
  const h = ctx({
    getCurrentMode: () => 'reserved2',
    getSelfState: () => ({ socialHunger: 0.9, energy: 0.1, stress: 0.2 }),
    computeProactivity: () => 0.9,
    decideContinue: () => false,
    decideJoin: () => ({ ok: true, why: 'test' }),
    scheduleWakeWithSecretary: async () => { scheduled.push(1); },
    stateHub: { selectIntention: () => ({ selected: { type: 'rest', reason: '精力见底' } }) },
  });
  const st = {
    recentMessages: [
      { text: 'a', isSelf: false, time: Date.now() - 60e3 },
      { text: 'b', isSelf: false, time: Date.now() - 50e3 },
      { text: 'c', isSelf: false, time: Date.now() - 40e3 },
    ],
    wakeConfig: { triggers: { probability: 0.9 } },
    lastJoinAt: 0, joinWakeTimes: [], continueWakeTimes: [],
  };
  h.svc.maybeJoinOrContinue('group:1', st);
  assert.equal(scheduled.length, 0, '意志拦截后不应安排唤醒');
  assert.equal(st.lastJoinAt, 0);
});

test('意志驱动：想找人说话时上调插话适应度', () => {
  const seen = [];
  const h = ctx({
    getCurrentMode: () => 'reserved2',
    getSelfState: () => ({ socialHunger: 0.5, energy: 0.8, stress: 0 }),
    computeProactivity: () => 0.4,
    decideContinue: () => false,
    decideJoin: (o) => { seen.push(o.adaptive); return { ok: false, why: 'test' }; },
    stateHub: { selectIntention: () => ({ selected: { type: 'initiate', reason: '想找人说话' } }) },
  });
  const st = {
    recentMessages: [
      { text: 'a', isSelf: false, time: Date.now() - 60e3 },
      { text: 'b', isSelf: false, time: Date.now() - 50e3 },
      { text: 'c', isSelf: false, time: Date.now() - 40e3 },
    ],
    wakeConfig: { triggers: { probability: 0.5 } },
    lastJoinAt: 0, joinWakeTimes: [], continueWakeTimes: [],
  };
  h.svc.maybeJoinOrContinue('group:1', st);
  assert.ok(seen[0] > 0.4, 'initiate 应上调适应度: ' + seen[0]);
});
