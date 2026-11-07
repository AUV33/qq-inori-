// 会话生命周期集成测试：真的把 session-create 和 session-retire 拼在一起。
//
// 补的缺口（docs/internal/_archive/规划/闭环与咬合-20261103.md §4「仍在」第 2 条）：
// 两个模块各有单测，但各自用假桩——「创建 → 退役 → 恢复」这条路上，映射/反向表/
// DSH 订阅/按 key 记账的缓存是否一起正确迁移，只在 app 运行时被证明过。
// 这里用一套共享的 state/Map/Set + 假 DSH api，走完整流程，不碰网络与磁盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCreate } from '../src/domain/conversation/session-create.mjs';
import { createSessionRetire } from '../src/domain/conversation/session-retire.mjs';

function makeHarness({ mode = 'reserved2', preset = 'qq-chat-v2', chatModel = async () => 'applied', createImpl = null } = {}) {
  const state = { sessions: {}, sessionPolicies: {} };
  const reverse = new Map();
  const sessionPromises = new Map();
  const out = {
    logs: [], created: [], archived: [], followed: [], forgotten: [], stopped: [],
    saveState: 0, saveSocialV2: 0, clearFailed: [], resetWs: 0, ensureModel: [],
  };
  const maps = {
    activeWaits: new Map(), queuedHintAt: new Map(), slangSubmitTimes: new Map(),
    feedbackTimes: new Map(), wakeConfigMissCount: new Map(),
  };
  const sets = { wakeConfigUpdatedKeys: new Set(), markReadCalledKeys: new Set(), pendingWakeKeys: new Set() };
  const collectors = new Map();
  const modelApplied = new Map();
  const sendToolSucceeded = new Set();
  const pendingSendToolCalls = new Map();
  const waitToolCalls = new Map();
  const waitStartAt = new Map();
  const turnWaitMs = new Map();
  const v2TurnStartAt = new Map();
  const toolCallNames = new Map();
  const pending = new Map();
  const social = { silentTurns: new Set(), exitingSessions: new Set() };
  const socialV2 = { conversations: new Map() };
  const outgoing = { clearFailed: (key) => out.clearFailed.push(key) };
  const api = {
    sessions: {
      create: async (params) => {
        out.created.push(params);
        if (createImpl) return createImpl(params, out.created.length);
        return { sessionId: `sess-${out.created.length}` };
      },
    },
    events: {
      follow: (sid) => out.followed.push(sid),
      forget: (sid) => out.forgotten.push(sid),
    },
    stopSessionWork: async (sid) => { out.stopped.push(sid); return {}; },
    workspace: { archiveSession: async ({ sessionId }) => { out.archived.push(sessionId); } },
  };
  const log = (m) => out.logs.push(String(m));
  const isCurrentSession = (key, sid) => state.sessions[key] === sid;

  const retire = createSessionRetire({
    api, log, state,
    saveState: () => { out.saveState += 1; },
    getOutgoing: () => outgoing,
    activeWaits: maps.activeWaits, queuedHintAt: maps.queuedHintAt, slangSubmitTimes: maps.slangSubmitTimes,
    feedbackTimes: maps.feedbackTimes, wakeConfigMissCount: maps.wakeConfigMissCount,
    wakeConfigUpdatedKeys: sets.wakeConfigUpdatedKeys, markReadCalledKeys: sets.markReadCalledKeys,
    sessionTelemetry: { forgetSession: (sid) => out.forgotten.push(`telemetry:${sid}`) },
    reverse, collectors,
    getModelAppliedSessions: () => modelApplied,
    sendToolSucceededSessions: sendToolSucceeded,
    pendingSendToolCalls,
    waitToolCalls, waitStartAt, turnWaitMs, v2TurnStartAt, toolCallNames,
    getSocial: () => social, getSocialV2: () => socialV2,
    getPending: () => pending,
    cancelPendingEntry: async () => {},
    clearSocialV2Timers: () => {}, cancelSocialTimers: () => {}, disarmPendingWakeLease: () => {},
    pendingWakeKeys: sets.pendingWakeKeys,
    rememberAgentToken: () => {},
    saveSocialV2State: () => { out.saveSocialV2 += 1; },
    isCurrentSession,
    isOwnerLaneKey: (key) => key.endsWith('#owner'),
    getDshPresetIds: () => ['qq-chat-v2'],
  });

  let epoch = 1;
  let workspace = 'ws-1';
  const create = createSessionCreate({
    getState: () => state,
    getSessionEpoch: () => epoch,
    getCfg: () => ({ agentPreset: 'qq-chat', socialV2: { agentPreset: 'qq-chat-v2' } }),
    getCurrentMode: () => mode,
    getDshPresetIds: () => ['qq-chat-v2'],
    sessionPolicy: (key) => `pol:${key}`,
    isSessionAllowedInCurrentMode: () => true,
    isCurrentSession,
    retireSession: (key) => retire.retireSession(key),
    ensureChatModel: async (sid) => { out.ensureModel.push(sid); return chatModel(sid); },
    ensureHerWorkspace: async () => workspace,
    resetHerWorkspace: () => { out.resetWs += 1; workspace = `ws-${out.resetWs + 1}`; },
    modePreset: () => preset,
    api,
    unwrap: (v) => v,
    log,
    sessionPromises,
    reverse,
    laneBaseKey: (key) => key.replace(/#owner$/, ''),
    saveState: () => { out.saveState += 1; },
  });

  return { create, retire, state, reverse, out, maps, sets, social, socialV2, collectors, pending, modelApplied, bumpEpoch: () => { epoch += 1; } };
}

const flush = () => new Promise((r) => setImmediate(r));

test('创建 → 退役 → 恢复：映射、反向表与 DSH 订阅一起迁移', async () => {
  const h = makeHarness();
  const id1 = await h.create.ensureSession('group:1001');
  assert.equal(h.state.sessions['group:1001'], id1);
  assert.equal(h.reverse.get(id1), 'group:1001');
  assert.deepEqual(h.out.followed, [id1], '新会话必须 follow，否则收不到 turn 事件');

  h.retire.retireSession('group:1001');
  assert.equal(h.state.sessions['group:1001'], undefined);
  assert.equal(h.reverse.has(id1), false);
  assert.ok(h.out.forgotten.includes(id1), '退役必须退订，否则重连时重发历史快照');
  assert.ok(h.out.stopped.includes(id1));
  await flush();
  assert.ok(h.out.archived.includes(id1), '退役要把 DSH 侧会话归档');

  const id2 = await h.create.ensureSession('group:1001');
  assert.notEqual(id2, id1);
  assert.equal(h.state.sessions['group:1001'], id2);
  assert.equal(h.reverse.get(id2), 'group:1001');
  assert.equal(h.reverse.has(id1), false);
});

test('DSH 侧会话丢失（not-found）：退役本地映射并当场重建，旧会话被归档', async () => {
  let call = 0;
  const h = makeHarness({
    chatModel: async () => {
      call += 1;
      return call === 2 ? 'not-found' : 'applied';
    },
  });
  const first = await h.create.ensureSession('group:1002');
  // 第二次进来时 existing 还在，ensureChatModel 返回 not-found → 必须退役并重建
  const second = await h.create.ensureSession('group:1002');
  assert.notEqual(second, first);
  assert.equal(h.state.sessions['group:1002'], second);
  assert.equal(h.reverse.has(first), false);
  await flush();
  assert.ok(h.out.archived.includes(first), '失效的旧会话要归档，不能只是本地删掉');
  assert.ok(h.out.forgotten.includes(first));
});

test('退役清掉按 key 记账的内存态（限流/失败/未读/待发/社交缓存）', async () => {
  const h = makeHarness();
  const id = await h.create.ensureSession('group:1003');
  h.maps.activeWaits.set('group:1003', id);
  h.maps.queuedHintAt.set('group:1003', 1);
  h.maps.slangSubmitTimes.set('group:1003', 1);
  h.maps.feedbackTimes.set('group:1003', 1);
  h.maps.wakeConfigMissCount.set('group:1003', 1);
  h.sets.markReadCalledKeys.add('group:1003');
  h.sets.pendingWakeKeys.add('group:1003');
  h.socialV2.conversations.set('group:1003', { agentToken: 'old-token', sessionTurns: 7, bootstrapSent: true });
  h.collectors.set(id, {});
  h.modelApplied.set(id, true);

  h.retire.retireSession('group:1003');
  for (const [name, map] of Object.entries(h.maps)) {
    assert.equal(map.has('group:1003'), false, `${name} 没清干净`);
  }
  assert.equal(h.sets.markReadCalledKeys.has('group:1003'), false);
  assert.equal(h.sets.pendingWakeKeys.has('group:1003'), false);
  assert.ok(h.out.clearFailed.includes('group:1003'), '发送失败标记要清，否则下一批会以为没成功');
  assert.equal(h.collectors.has(id), false);
  assert.equal(h.modelApplied.has(id), false);
  // token 轮换，但 bootstrapSent / sessionTurns 的语义要保留或重置成明确值
  const conv = h.socialV2.conversations.get('group:1003');
  assert.notEqual(conv.agentToken, 'old-token', '退役要轮换 agentToken（撤销旧调用权限）');
  assert.equal(conv.sessionTurns, 0, '换会话后回合计数从零开始');
  assert.equal(conv.bootstrapSent, true, '轮换不重置 bootstrap，避免下一条消息重新自我介绍');
});

test('主会话退役时 owner lane 一起退役', async () => {
  const h = makeHarness();
  const main = await h.create.ensureSession('group:1004');
  h.state.sessions['group:1004#owner'] = 'owner-sess';
  h.reverse.set('owner-sess', 'group:1004');
  h.retire.retireSession('group:1004');
  assert.equal(h.state.sessions['group:1004'], undefined);
  assert.equal(h.state.sessions['group:1004#owner'], undefined, 'admin 会话不能残留');
  assert.equal(h.reverse.has('owner-sess'), false);
});

test('创建期间发生 reset：新会话被丢弃并归档，不写进映射', async () => {
  const h = makeHarness();
  const pending = h.create.ensureSession('group:1005');
  h.bumpEpoch(); // 模拟手工 reset / 工作区清空发生在创建途中
  await assert.rejects(pending, /重置/);
  assert.equal(h.state.sessions['group:1005'], undefined);
  await flush();
  assert.ok(h.out.archived.includes('sess-1'), '丢弃的会话也要归档，否则 DSH 里留孤儿');
});

test('工作区被删（workspace not found）：重建工作区并重试创建', async () => {
  let n = 0;
  const h = makeHarness({
    createImpl: async () => {
      n += 1;
      if (n === 1) throw new Error('workspace not found');
      return { sessionId: `sess-retry-${n}` };
    },
  });
  const id = await h.create.ensureSession('group:1006');
  assert.equal(id, 'sess-retry-2', '第一次工作区失效后应重建并重试成功');
  assert.equal(h.out.resetWs, 1, '必须真的重置工作区缓存');
  assert.equal(h.state.sessions['group:1006'], id);
  assert.equal(h.reverse.get(id), 'group:1006');
  assert.ok(h.out.logs.some((l) => l.includes('[ws-recover]')), '重试成功要留痕');
});
