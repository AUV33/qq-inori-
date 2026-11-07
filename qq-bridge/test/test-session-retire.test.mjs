// session-retire 金标：会话退役要清干净（含 owner lane）、preset 清单未知时绝不批量退役。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRetire } from '../src/domain/conversation/session-retire.mjs';

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const maps = {
    activeWaits: new Map(), queuedHintAt: new Map(), slangSubmitTimes: new Map(), feedbackTimes: new Map(),
    wakeConfigMissCount: new Map(), wakeConfigUpdatedKeys: new Set(), markReadCalledKeys: new Set(),
    reverse: new Map(), collectors: new Map(), sendToolSucceeded: new Set(), pendingSendToolCalls: new Map(),
    waitToolCalls: new Map(), waitStartAt: new Map(), turnWaitMs: new Map(), v2TurnStartAt: new Map(),
    toolCallNames: new Map(), modelApplied: new Map(), pending: new Map(), pendingWakeKeys: new Set(),
  };
  const out = { logs: [], saves: 0, socialSaves: 0, cleared: [], archived: [], stopped: [], forgotEvents: [], remembered: [], cancelled: [] };
  const social = { silentTurns: new Set(), exitingSessions: new Set() };
  const state = overrides.state ?? { sessions: {}, sessionPolicies: {} };
  const conversations = new Map();
  const svc = createSessionRetire({
    api: {
      stopSessionWork: async (sid) => { out.stopped.push(sid); return overrides.stopResult ?? {}; },
      workspace: { archiveSession: async ({ sessionId }) => { out.archived.push(sessionId); } },
      events: { forget: (sid) => out.forgotEvents.push(sid) },
    },
    log: (m) => out.logs.push(String(m)),
    state,
    saveState: () => { out.saves += 1; },
    getOutgoing: () => ({ clearFailed: (key) => out.cleared.push(key) }),
    activeWaits: maps.activeWaits,
    queuedHintAt: maps.queuedHintAt,
    slangSubmitTimes: maps.slangSubmitTimes,
    feedbackTimes: maps.feedbackTimes,
    wakeConfigMissCount: maps.wakeConfigMissCount,
    wakeConfigUpdatedKeys: maps.wakeConfigUpdatedKeys,
    markReadCalledKeys: maps.markReadCalledKeys,
    sessionTelemetry: { forgetSession: (sid) => out.forgotTelemetry = sid },
    reverse: maps.reverse,
    collectors: maps.collectors,
    getModelAppliedSessions: () => maps.modelApplied,
    sendToolSucceededSessions: maps.sendToolSucceeded,
    pendingSendToolCalls: maps.pendingSendToolCalls,
    waitToolCalls: maps.waitToolCalls,
    waitStartAt: maps.waitStartAt,
    turnWaitMs: maps.turnWaitMs,
    v2TurnStartAt: maps.v2TurnStartAt,
    toolCallNames: maps.toolCallNames,
    getSocial: () => social,
    getSocialV2: () => ({ conversations }),
    getPending: () => maps.pending,
    cancelPendingEntry: async (entry) => { out.cancelled.push(entry.key); },
    clearSocialV2Timers: () => {},
    cancelSocialTimers: () => {},
    disarmPendingWakeLease: () => {},
    pendingWakeKeys: maps.pendingWakeKeys,
    rememberAgentToken: (key, token) => out.remembered.push({ key, token }),
    saveSocialV2State: () => { out.socialSaves += 1; },
    isCurrentSession: (key, sid) => overrides.isCurrent ? overrides.isCurrent(key, sid) : state.sessions[key] === sid,
    isOwnerLaneKey: (key) => String(key).endsWith('#owner'),
    getDshPresetIds: () => overrides.presetIds ?? ['qq-chat-v2'],
    ...overrides.ctxExtra,
  });
  return { svc, out, maps, state, social, conversations };
}

test('forgetConversationCaches：按 key 记账的内存态一次清干净', () => {
  const h = makeCtx();
  for (const m of [h.maps.activeWaits, h.maps.queuedHintAt, h.maps.slangSubmitTimes, h.maps.feedbackTimes, h.maps.wakeConfigMissCount]) m.set('group:1', 1);
  h.maps.wakeConfigUpdatedKeys.add('group:1');
  h.maps.markReadCalledKeys.add('group:1');
  h.svc.forgetConversationCaches('group:1');
  assert.equal(h.maps.activeWaits.has('group:1'), false);
  assert.equal(h.maps.slangSubmitTimes.has('group:1'), false);
  assert.equal(h.maps.wakeConfigUpdatedKeys.has('group:1'), false);
  assert.equal(h.maps.markReadCalledKeys.has('group:1'), false);
  assert.deepEqual(h.out.cleared, ['group:1']);
});

test('retireSession：没有映射也要清按 key 的缓存，且不碰 DSH', async () => {
  const h = makeCtx();
  h.maps.feedbackTimes.set('group:9', 1);
  h.svc.retireSession('group:9');
  assert.equal(h.maps.feedbackTimes.has('group:9'), false);
  await flush();
  assert.equal(h.out.stopped.length, 0);
  assert.equal(h.out.saves, 0, '没有会话映射就不必落 state');
});

test('retireSession：有映射时清会话级缓存、撤销订阅、轮换 token，并停掉/归档旧会话', async () => {
  const h = makeCtx();
  h.state.sessions['group:1'] = 'sid-1';
  h.state.sessionPolicies['group:1'] = 'p1';
  h.maps.reverse.set('sid-1', 'group:1');
  h.maps.collectors.set('sid-1', {});
  h.maps.modelApplied.set('sid-1', 1);
  h.maps.sendToolSucceeded.add('sid-1');
  h.maps.waitToolCalls.set('sid-1', new Set());
  h.maps.waitStartAt.set('sid-1', 1);
  h.maps.turnWaitMs.set('sid-1', 1);
  h.maps.v2TurnStartAt.set('sid-1', 1);
  h.maps.toolCallNames.set('sid-1', new Set());
  h.maps.pendingWakeKeys.add('group:1');
  h.maps.pending.set('group:1', { key: 'group:1', timer: setTimeout(() => {}, 10_000) });
  h.maps.pending.get('group:1').timer.unref?.();
  h.social.silentTurns.add('sid-1');
  h.social.exitingSessions.add('sid-1');
  const st = { agentToken: 'old', sessionTurns: 7, modelSeenSeqs: new Set([1, 2]), bootstrapSent: true };
  h.conversations.set('group:1', st);

  h.svc.retireSession('group:1');

  assert.equal(h.state.sessions['group:1'], undefined);
  assert.equal(h.state.sessionPolicies['group:1'], undefined);
  assert.equal(h.maps.reverse.has('sid-1'), false);
  assert.equal(h.maps.collectors.has('sid-1'), false);
  assert.equal(h.maps.v2TurnStartAt.has('sid-1'), false);
  assert.equal(h.maps.pendingWakeKeys.has('group:1'), false);
  assert.deepEqual(h.out.forgotEvents, ['sid-1'], '退役要退订事件流，否则重连重放开销线性增长');
  assert.equal(h.out.remembered.length, 1);
  assert.equal(st.agentToken, h.out.remembered[0].token);
  assert.equal(st.sessionTurns, 0);
  assert.equal(st.bootstrapSent, true, '轮换不是新对话，不能重置 bootstrapSent（否则重复自我介绍）');
  assert.deepEqual([...st.modelSeenSeqs], [1, 2], '保留已展示水位，否则未读永远清不掉');
  assert.equal(h.out.saves, 1);
  assert.equal(h.out.socialSaves, 1);
  await flush();
  assert.deepEqual(h.out.stopped, ['sid-1']);
  assert.deepEqual(h.out.archived, ['sid-1']);
  assert.ok(h.out.logs.some((l) => l.includes('停用旧映射')));
});

test('retireSession：主会话退役会连带 owner lane一起退役；owner lane 自己不递归', async () => {
  const h = makeCtx();
  h.state.sessions['group:1'] = 'sid-main';
  h.state.sessions['group:1#owner'] = 'sid-owner';
  h.state.sessionPolicies['group:1#owner'] = 'p';
  h.svc.retireSession('group:1');
  assert.equal(h.state.sessions['group:1'], undefined);
  assert.equal(h.state.sessions['group:1#owner'], undefined, 'owner lane 不能残留旧 admin 会话');

  const h2 = makeCtx();
  h2.state.sessions['group:2#owner'] = 'sid-owner2';
  h2.svc.retireSession('group:2#owner');
  assert.equal(h2.state.sessions['group:2#owner'], undefined);
});

test('reconcileSessionPolicies：DSH preset 清单未知时一个都不退役（防一次抖动全体失忆）', () => {
  const h = makeCtx({ presetIds: [] });
  h.state.sessions['group:1'] = 'sid-1';
  h.svc.reconcileSessionPolicies();
  assert.equal(h.state.sessions['group:1'], 'sid-1');
  assert.equal(h.out.logs.length, 0);
});

test('reconcileSessionPolicies：只退役策略已不匹配的会话', () => {
  const h = makeCtx({ isCurrent: (key, sid) => sid === 'sid-keep' });
  h.state.sessions['group:1'] = 'sid-stale';
  h.state.sessions['group:2'] = 'sid-keep';
  h.svc.reconcileSessionPolicies();
  assert.equal(h.state.sessions['group:1'], undefined);
  assert.equal(h.state.sessions['group:2'], 'sid-keep');
});

test('stopRetiredSessionWork：队列读取失败/归档失败都只记日志，不外抛', async () => {
  const failing = makeCtx({
    stopResult: { queueError: '队列读不到' },
    ctxExtra: {
      api: {
        stopSessionWork: async () => ({ queueError: '队列读不到' }),
        workspace: { archiveSession: async () => { throw new Error('归档失败'); } },
        events: { forget: () => {} },
      },
    },
  });
  failing.svc.stopRetiredSessionWork('sid-x', 'group:1');
  await flush();
  assert.ok(failing.out.logs.some((l) => l.includes('旧会话队列读取失败')));
  assert.ok(failing.out.logs.some((l) => l.includes('归档失效会话失败')));
});
