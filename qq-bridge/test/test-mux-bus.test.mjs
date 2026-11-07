// 金标单测：src/mux-bus.mjs 的 pumpMux
//
// pumpMux(deps) 是「事件流 → 桥接状态机」的总泵：模块零 import、所有能力经 __deps 注入。
// 这里用全套桩 deps + 可控 async generator 喂帧，只测状态机分支，不连 WS、不读写 state/。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pumpMux } from '../src/adapters/mux-bus.mjs';
import { createTurnCollector } from '../src/adapters/dsh-client.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mux-bus-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const STOP = new Error('stop-pump');

// ── 桩 deps 工厂 ─────────────────────────────────────────────────────────────
// 每个键都显式给出：pumpMux 的依赖面很大，缺一个键会变成 TypeError（而不是静默跳过），
// 这样测试能在第一时间暴露「接线漏了」。
function makeHarness(overrides = {}) {
  const calls = [];
  const logs = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const log = (...args) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const socialV2States = new Map();
  const socialStates = new Map();
  const defaultWakeConfig = () => ({ noActionCount: 0, intervalMs: 60000 });
  const getSocialV2State = (key) => {
    const k = String(key);
    if (!socialV2States.has(k)) {
      socialV2States.set(k, {
        unread: [],
        pendingWakeReasons: [],
        wakeConfig: defaultWakeConfig(),
        lastActionAt: 0,
        lastWakeReason: null,
        pendingThoughts: [],
        noSendHint: null,
      });
    }
    return socialV2States.get(k);
  };
  const socialState = (key) => {
    const k = String(key);
    if (!socialStates.has(k)) socialStates.set(k, { phase: 'idle', activeDeadlineAt: 0, activeExitAt: 0 });
    return socialStates.get(k);
  };

  const deps = {
    // 基础设施
    log,
    sleep: async () => { throw STOP; },
    cfg: { socialV2: { wake: {}, lessons: {}, goals: {} }, social: {}, security: {} },
    state: { sessions: {} },
    currentMode: 'normal',
    fs: { appendFileSync: rec('fs.appendFileSync'), readFileSync: () => '{}' },
    stateDataPath: (name) => path.join(TMP, 'state-data', name),
    api: {
      events: { follow: rec('api.events.follow'), forget: rec('api.events.forget') },
      respond: async (msg) => { calls.push({ name: 'api.respond', args: [msg] }); return {}; },
    },

    // 事件消费
    recordSessionSnapshot: rec('recordSessionSnapshot'),
    recordSessionUsage: rec('recordSessionUsage'),
    captureReasoning: rec('captureReasoning'),
    noteTurnStart: rec('noteTurnStart'),
    consumeTurnGrant: rec('consumeTurnGrant'),
    cancelTransientArchive: rec('cancelTransientArchive'),
    flushReasoning: rec('flushReasoning'),
    scheduleTransientArchive: rec('scheduleTransientArchive'),
    drainOwnlifeQueue: rec('drainOwnlifeQueue'),
    turnDispatch: { finish: rec('turnDispatch.finish') },

    // 集合状态
    activeWaits: new Map(),
    autoCancelledKeys: new Set(),
    browseLearnWindow: [],
    browseStore: [],
    busySinceMs: new Map(),
    collectors: new Map(),
    diaryForcedDays: new Set(),
    diarySessions: new Map(),
    gateBatches: new Map(),
    gateCollectors: new Map(),
    gateSessions: new Set(),
    groupFactCollectors: new Map(),
    groupFactSessions: new Set(),
    groupFactWaiters: new Map(),
    isolatedDead: new Set(),
    saveIsolatedDead: rec('saveIsolatedDead'),
    isolatedKindBySession: new Map(),
    isolatedSessions: new Map(),
    learnerCollectors: new Map(),
    learnerSessions: new Set(),
    lessonPendingByKey: new Map(),
    markReadCalledKeys: new Set(),
    noKeyToolNames: new Map(),
    pendingSendToolCalls: new Map(),
    pendingWakeKeys: new Set(),
    reverse: new Map(),
    sendToolSucceededSessions: new Set(),
    slangEntries: [],
    social: { silentTurns: new Map(), exitingSessions: new Set() },
    taskCollectors: new Map(),
    taskSessions: new Set(),
    thoughtCollectors: new Map(),
    thoughtSessions: new Set(),
    toolCallArgs: new Map(),
    toolCallNames: new Map(),
    turnSeenHeads: new Map(),
    turnToolStats: new Map(),
    turnWaitMs: new Map(),
    v2TurnStartAt: new Map(),
    waitStartAt: new Map(),
    waitToolCalls: new Map(),
    wakeConfigMissCount: new Map(),
    wakeConfigUpdatedKeys: new Set(),

    // 工具 / 轨迹 / 浏览
    noteBrowse: (store, entry) => { calls.push({ name: 'noteBrowse', args: [store, entry] }); return [...store, entry]; },
    newBrowseEntry: (entry) => { calls.push({ name: 'newBrowseEntry', args: [entry] }); return { ...entry }; },
    browseSave: rec('browseSave'),
    noteToolFailure: rec('noteToolFailure'),
    autoTraceToolFailure: rec('autoTraceToolFailure'),
    noteLiveToolResult: rec('noteLiveToolResult'),
    noteDeviceFailure: rec('noteDeviceFailure'),
    resolveToolFailure: rec('resolveToolFailure'),
    isPhoneTool: (name) => /^mcp__phone__|^phone_/.test(String(name)),
    isSendToolName: (name) => name === 'qq_send_message',
    sanitizeToolArgs: (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')),
    errToText: (v) => String(v ?? ''),
    lastPhoneOpAt: 0,
    lifeState: {},
    markCuriosityStimulus: (life, amount) => ({ ...life, curiosity: (life.curiosity || 0) + amount }),
    saveLifeFile: rec('saveLifeFile'),
    activityTracker: { record: rec('activityTracker.record'), finish: () => null },

    // 任务台账 / 工作台
    taskPoolRunning: [],
    parseTaskResult: () => null,
    checkVerify: async () => ({ ok: true, evidence: '' }),
    finishTask: (taskId, opts) => {
      calls.push({ name: 'finishTask', args: [taskId, opts] });
      return { row: { id: taskId || 't1', task: '任务', reportTo: 'private:x' }, idempotent: false };
    },
    notifyTaskDone: rec('notifyTaskDone'),
    appendTrace: rec('appendTrace'),
    retireTaskSession: async (sessionId, reason) => { calls.push({ name: 'retireTaskSession', args: [sessionId, reason] }); },
    workByTaskId: () => null,
    updateWorkById: (id, fn) => {
      calls.push({ name: 'updateWorkById', args: [id] });
      const next = fn({ id, status: 'running', progress: [] });
      calls.push({ name: 'updateWorkById.next', args: [next] });
      return next;
    },
    summarizeWorkerText: (text, max) => String(text || '').trim().slice(0, max),
    addProgress: (work, note) => ({ ...work, progress: [...(work.progress || []), { note }] }),
    setWorkStatus: (work, status) => { calls.push({ name: 'setWorkStatus', args: [status] }); return { ...work, status }; },
    WORK_STATUS: { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' },

    // 念头 / 日记 / 反思
    lastThoughtTurn: null,
    logAction: rec('logAction'),
    appendThought: (...args) => { calls.push({ name: 'appendThought', args }); return { id: 'th-1' }; },
    addGoalIdea: (...args) => { calls.push({ name: 'addGoalIdea', args }); return { id: 'g-1' }; },
    similarThoughtCount: () => 0,
    extractThoughtLines: () => [],
    parseFocusBlock: () => null,
    saveFocusBlock: (...args) => { calls.push({ name: 'saveFocusBlock', args }); return 2; },
    FOCUS_SLOTS: ['focusNow', 'focusNext'],
    FOCUS_SLOT_CN: { focusNow: '现在', focusNext: '下一步' },
    appendDailyDiary: rec('appendDailyDiary'),
    diaryAttempts: () => 0,
    dropDiaryAttempt: rec('dropDiaryAttempt'),
    startDiarySession: async (...args) => { calls.push({ name: 'startDiarySession', args }); },
    vision: { handleEvent: rec('vision.handleEvent') },

    // 门 / 黑话学习 / 群事实
    parseGateReply: () => ({ hits: [] }),
    applyGateHits: rec('applyGateHits'),
    appendGateLog: rec('appendGateLog'),
    learnerWaiters: new Map(),
    slangLearnerSessionId: null,
    SLANG_FILE: path.join(TMP, 'slang.json'),
    loadLessons: () => [],
    extractTerms: () => [],
    upsertSlangEntry: rec('upsertSlangEntry'),
    saveSlang: rec('saveSlang'),

    // 社交 / 唤醒
    getSocialV2State,
    socialState,
    saveSocialV2State: rec('saveSocialV2State'),
    defaultWakeConfigV2: defaultWakeConfig,
    ensureWakeableV2: rec('ensureWakeableV2'),
    armPendingWakeLease: rec('armPendingWakeLease'),
    disarmPendingWakeLease: rec('disarmPendingWakeLease'),
    clearAllPendingWakeLeases: rec('clearAllPendingWakeLeases'),
    wakePriorityV2: (reason) => ({ mention: 3, message: 2, taskDone: 1 }[reason] ?? 0),
    scheduleWakeV2: rec('scheduleWakeV2'),
    scheduleNextAtSplit: rec('scheduleNextAtSplit'),
    deliverPrompt: async (...args) => { calls.push({ name: 'deliverPrompt', args }); return { ok: true }; },
    buildWakeReminderPromptV2: () => 'reminder-prompt',
    takeExpiredHint: () => null,
    sinkUnsentHint: rec('sinkUnsentHint'),
    isSilentMarker: () => false,
    mdToPlain: (text) => String(text ?? ''),
    isSocialEnabled: () => false,
    shouldBlockSilentReply: () => false,
    lastSendSucceeded: () => true,
    planSocialTimeline: (plain) => ({ main: [plain] }),
    sendToQQ: async (key, text) => { calls.push({ name: 'sendToQQ', args: [key, text] }); return { ok: true }; },
    sendBurstToQQ: async (key, messages, socialCfg) => { calls.push({ name: 'sendBurstToQQ', args: [key, messages, socialCfg] }); return { ok: true }; },
    sendNotice: async (key, text) => { calls.push({ name: 'sendNotice', args: [key, text] }); return { ok: true }; },
    sendGuardCheckV2: async (...args) => { calls.push({ name: 'sendGuardCheckV2', args }); },
    noteSilentTurnEndV2: rec('noteSilentTurnEndV2'),
    retireSession: rec('retireSession'),
    sendWakePromptV2: async (...args) => { calls.push({ name: 'sendWakePromptV2', args }); },
    appendActivity: rec('appendActivity'),
    appendToolLog: rec('appendToolLog'),
    registerPending: async (key, payload) => { calls.push({ name: 'registerPending', args: [key, payload] }); },
    cancelPendingEntry: async (payload) => { calls.push({ name: 'cancelPendingEntry', args: [payload] }); },
    shouldAuditKey: () => false,
    isCurrentSession: () => true,
    SENSITIVE_RE: /SECRET_[A-Z]+/,
    KNOWN_AGENT_TOKENS: new Set(),
    SILENT_MARKER: '[[SILENT]]',
    SILENT_TURN_TIMEOUT_MS: 60 * 1000,

    // 活动 / 技能 / 目标
    applyTurnToolLearning: async (...args) => { calls.push({ name: 'applyTurnToolLearning', args }); },
    optimizeSkill: () => ({ changed: false }),
    saveSkills: rec('saveSkills'),
    loadGoals: () => ({}),
    saveGoals: rec('saveGoals'),
    addGoalRow: () => ({ ok: false }),
    addRumination: rec('addRumination'),
    createTurnCollector,

    ...overrides,
  };

  const harness = {
    deps,
    calls,
    logs,
    socialV2States,
    socialStates,
    called(name) { return calls.filter((c) => c.name === name).map((c) => c.args); },
    count(name) { return this.called(name).length; },
    logText() { return logs.join('\n'); },
  };
  return harness;
}

/** 跑一轮 pumpMux：按顺序喂帧，最后靠 sleep 桩抛 STOP 退出 for(;;)。 */
async function pumpWith(h, frames) {
  h.deps.api.events.mux = async function* () {
    for (const frame of frames) yield { rpcId: `rpc-${frame.type}`, payload: frame };
  };
  const err = await pumpMux(h.deps).then(() => null, (e) => e);
  assert.equal(err, STOP, 'pumpMux 应由 sleep 桩终止（而不是自己 resolve/抛别的错）');
  return h;
}
async function runPump(frames, overrides = {}) {
  return pumpWith(makeHarness(overrides), frames);
}

const ev = (sessionId, event) => ({ type: 'session/event', sessionId, event });
const started = (sessionId, turn = 't1') => ev(sessionId, { type: 'turn/start', data: { turn } });
const said = (sessionId, text, turn = 't1') => ev(sessionId, {
  type: 'assistant/message',
  data: { turn, message: { content: [{ type: 'text', text }] } },
});
const endedWith = (sessionId, reason, turn = 't1') => ev(sessionId, { type: 'turn/end', data: { turn, reason } });
const completed = { kind: 'completed' };

function keyedSession(h, sessionId, key) {
  h.deps.reverse.set(sessionId, key);
  return sessionId;
}

// ── 帧类型分派 ──────────────────────────────────────────────────────────────

test('pumpMux: session/snapshot 只喂 token 账本，不走 session/event 通道', async () => {
  const h = await runPump([
    { type: 'session/snapshot', sessionId: 'sess-a', snapshot: { projections: { tokens: 42 }, records: [] } },
  ]);
  assert.equal(h.count('recordSessionSnapshot'), 1);
  assert.deepEqual(h.called('recordSessionSnapshot')[0], ['sess-a', { projections: { tokens: 42 }, records: [] }]);
  assert.equal(h.count('recordSessionUsage'), 0);
  assert.equal(h.count('sendToQQ'), 0);
});

test('pumpMux: 未知/错误帧只记日志', async () => {
  const h = await runPump([{ type: 'stream/error', error: { code: 'boom' } }]);
  assert.match(h.logText(), /事件流错误:/);
  assert.match(h.logText(), /boom/);
});

test('pumpMux: 无 key 会话的 question/requested 直接忽略', async () => {
  const h = await runPump([
    { type: 'question/requested', sessionId: 'unmapped', clientId: 'c', eventId: 'e', questions: [] },
  ]);
  assert.equal(h.count('sendToQQ'), 0);
  assert.equal(h.count('registerPending'), 0);
});

test('pumpMux: question/requested → 格式化发 QQ + 登记 pending + 敏感文本隐藏', async () => {
  const h = makeHarness({ shouldAuditKey: () => true, SENSITIVE_RE: /secret/i });
  keyedSession(h, 'sess-q', 'private:1001');
  const frame = {
    type: 'question/requested',
    sessionId: 'sess-q',
    clientId: 'client-1',
    eventId: 'evt-1',
    questions: [
      { id: 'q1', question: 'what is your secret?', options: [{ label: 'ok' }, { label: 'secret option' }] },
      { id: 'q2', question: 'plain' },
    ],
  };
  await pumpWith(h, [frame]); // pumpWith 已断言 STOP；以下看副作用
  const sends = h.called('sendToQQ');
  assert.equal(sends.length, 1);
  const [key, text] = sends[0];
  assert.equal(key, 'private:1001');
  assert.match(text, /❓ agent 需要你回答：/);
  assert.match(text, /1\. （含敏感信息，已隐藏）/);
  assert.match(text, /「ok」/);
  assert.match(text, /「（含敏感信息，已隐藏）」/);
  assert.match(text, /2\. plain/);

  const pend = h.called('registerPending');
  assert.equal(pend.length, 1);
  assert.equal(pend[0][0], 'private:1001');
  assert.equal(pend[0][1].kind, 'question');
  assert.equal(pend[0][1].rpcId, 'rpc-question/requested');
  assert.equal(pend[0][1].sessionId, 'sess-q');
  assert.equal(pend[0][1].clientId, 'client-1');
  assert.equal(pend[0][1].eventId, 'evt-1');
  assert.equal(pend[0][1].questions.length, 2);
});

test('pumpMux: question/requested 非当前会话 → 取消待处理条目，不发 QQ', async () => {
  const h = makeHarness({ isCurrentSession: () => false });
  keyedSession(h, 'sess-old', 'private:1');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r', payload: { type: 'question/requested', sessionId: 'sess-old', clientId: 'c', eventId: 'e', questions: [] } };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('sendToQQ'), 0);
  assert.equal(h.count('registerPending'), 0);
  const cancel = h.called('cancelPendingEntry');
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0][0].kind, 'question');
  assert.equal(cancel[0][0].sessionId, 'sess-old');
});

test('pumpMux: approval/requested → 发 QQ + 登记 pending，敏感理由隐藏', async () => {
  const h = makeHarness({ shouldAuditKey: () => true, SENSITIVE_RE: /secret/i });
  keyedSession(h, 'sess-a', 'group:55');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r-approve', payload: { type: 'approval/requested', sessionId: 'sess-a', clientId: 'c', eventId: 'e', toolName: 'secret_tool', reason: 'because secret' } };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  const sends = h.called('sendToQQ');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], 'group:55');
  assert.match(sends[0][1], /🔐 agent 请求审批：（含敏感信息，已隐藏）/);
  assert.match(sends[0][1], /理由：（含敏感信息，已隐藏）/);
  assert.match(sends[0][1], /回复「通过」或「拒绝」/);
  assert.equal(h.called('registerPending')[0][1].kind, 'approval');
});

test('pumpMux: 黑话学习会话的提问/审批自动跳过（不阻塞学习）', async () => {
  const h = makeHarness();
  h.deps.learnerSessions.add('learner-s');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: { type: 'question/requested', sessionId: 'learner-s', clientId: 'c1', eventId: 'e1', questions: [{ id: 'q1' }, { id: 'q2' }] } };
    yield { rpcId: 'r2', payload: { type: 'approval/requested', sessionId: 'learner-s', clientId: 'c2', eventId: 'e2', toolName: 'x' } };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  const answers = h.called('api.respond');
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0][0].outcome.value, { answers: [{ id: 'q1', selected: [], custom: '' }, { id: 'q2', selected: [], custom: '' }] });
  assert.equal(answers[1][0].outcome.value, 'rejected');
  assert.equal(h.count('sendToQQ'), 0);
  assert.match(h.logText(), /黑话学习会话自动跳过提问\/审批/);
});

// ── keyed 会话：turn 生命周期 ────────────────────────────────────────────────

test('pumpMux: turn/start 记账 + 清空上回合发送标记', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-k', 'private:1');
  h.deps.sendToolSucceededSessions.add(sid);
  h.deps.pendingSendToolCalls.set(sid, new Set(['old']));
  const before = Date.now();
  const snap = {};
  // 在 yield 之后取快照：此时本帧已处理完、pumpMux 的 finally 还没清状态。
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    snap.v2 = h.deps.v2TurnStartAt.get(sid);
    snap.sendFlag = h.deps.sendToolSucceededSessions.has(sid);
    snap.pendingCalls = h.deps.pendingSendToolCalls.has(sid);
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.count('recordSessionUsage'), 1);
  assert.equal(h.count('captureReasoning'), 1);
  assert.equal(h.count('noteTurnStart'), 1);
  assert.equal(h.count('consumeTurnGrant'), 1);
  assert.equal(h.count('cancelTransientArchive'), 1);
  assert.equal(snap.sendFlag, false, 'turn/start 应清掉上回合的发送成功标记');
  assert.equal(snap.pendingCalls, false, 'turn/start 应清掉上回合的 pending 发送调用');
  assert.ok(snap.v2 >= before, '应记录本回合开始时刻');
  assert.match(h.logText(), /\[turn\] start private:1/);
});

test('pumpMux: tool/call 记录工具名/参数、好奇充电、手机轨迹与发送/等待登记', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-t', 'private:1');
  const snap = {};
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'web_search', callId: 'c1', arguments: '{"q":"猫"}' } }) };
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/call', data: { name: 'phone_open', callId: 'c2', arguments: { app: 'qq' } } }) };
    yield { rpcId: 'r3', payload: ev(sid, { type: 'tool/call', data: { name: 'qq_send_message', callId: 'c3', arguments: { text: 'hi' } } }) };
    yield { rpcId: 'r4', payload: ev(sid, { type: 'tool/call', data: { name: 'qq_wait_for_messages', callId: 'c4' } }) };
    snap.pendingSend = h.deps.pendingSendToolCalls.get(sid)?.has('c3');
    snap.waitCalls = h.deps.waitToolCalls.get(sid)?.has('c4');
    snap.waitStart = h.deps.waitStartAt.get(sid);
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.count('appendToolLog'), 4);
  const firstLog = h.called('appendToolLog')[0][0];
  assert.equal(firstLog.type, 'call');
  assert.equal(firstLog.tool, 'web_search');
  assert.equal(firstLog.args, '{"q":"猫"}');
  assert.equal(h.deps.toolCallArgs.get(sid).get('c1'), '{"q":"猫"}');
  assert.ok(h.deps.lifeState.curiosity > 0, 'web_search 应给好奇充电');
  assert.ok(h.deps.lastPhoneOpAt > 0, 'phone_* 应记录最后操作时刻');
  assert.equal(h.count('activityTracker.record'), 1);
  assert.equal(snap.pendingSend, true);
  assert.equal(snap.waitCalls, true);
  assert.ok(snap.waitStart > 0);
  assert.equal(h.deps.turnToolStats.get(sid).names.has('qq_send_message'), true);
});

test('pumpMux: tool/result 成功 → 浏览留痕、发送成功标记、工具名清理', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-r', 'private:1');
  const sent = [];
  h.deps.noteLifeSent = (k, tool) => sent.push([k, tool]);
  const snap = {};
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'web_search', callId: 'c1', arguments: '{"q":"猫"}' } }) };
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ text: '搜索结果 猫' }], isError: false } } }) };
    yield { rpcId: 'r3', payload: ev(sid, { type: 'tool/call', data: { name: 'qq_send_message', callId: 'c2', arguments: { text: 'hi' } } }) };
    yield { rpcId: 'r4', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ text: 'ok' }], isError: false } } }) };
    snap.sendFlag = h.deps.sendToolSucceededSessions.has(sid);
    snap.pendingGone = !h.deps.pendingSendToolCalls.has(sid);
    snap.nameGone = h.deps.toolCallNames.get(sid)?.has('c1') === false;
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  const resultLogs = h.called('appendToolLog').filter((a) => a[0].type === 'result');
  assert.equal(resultLogs.length, 2);
  assert.equal(resultLogs[0][0].tool, 'web_search');
  assert.equal(resultLogs[0][0].ok, true);

  assert.equal(h.count('noteBrowse'), 1);
  const entry = h.called('newBrowseEntry')[0][0];
  assert.equal(entry.tool, 'web_search');
  assert.equal(entry.ok, true);
  assert.match(entry.head, /搜索结果 猫/);
  assert.equal(h.deps.browseStore.length, 1);
  assert.deepEqual(h.deps.turnSeenHeads.get('private:1'), ['web_search: 搜索结果 猫']);
  assert.equal(snap.sendFlag, true, '发送工具成功应标记，避免自动转发重复');
  assert.equal(snap.pendingGone, true);
  assert.equal(snap.nameGone, true);
  assert.equal(h.deps.turnToolStats.get(sid).ok, 2);
  assert.deepEqual(sent, [['private:1', 'qq_send_message']], '发送成功要落生命线');
});

test('pumpMux: tool/result 失败 → 留失败痕迹、不算发送成功', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-e', 'private:1');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'qq_send_message', callId: 'c1', arguments: {} } }) };
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ text: 'send failed', isError: true }] } } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.count('noteToolFailure'), 1);
  assert.equal(h.count('autoTraceToolFailure'), 1);
  assert.equal(h.count('noteLiveToolResult'), 1);
  assert.equal(h.deps.sendToolSucceededSessions.has(sid), false);
  assert.equal(h.deps.turnToolStats.get(sid).fail, 1);
  const log = h.called('appendToolLog').filter((a) => a[0].type === 'result')[0][0];
  assert.equal(log.ok, false);
  assert.match(log.error, /send failed/);
});

test('pumpMux: qq_wait_for_messages 的等待时长累加进 turnWaitMs', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-w', 'private:1');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'qq_wait_for_messages', callId: 'c1' } }) };
    // 模拟真实等待了 1.5s：只回拨状态里的开始时刻，不动系统时钟
    h.deps.waitStartAt.set(sid, Date.now() - 1500);
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ text: 'idle' }] } } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.ok(h.deps.turnWaitMs.get(sid) >= 1400, `等待时长应 >= 1400ms，实际 ${h.deps.turnWaitMs.get(sid)}`);
  assert.equal(h.deps.waitStartAt.has(sid), false);
  assert.equal(h.deps.waitToolCalls.has(sid), false);
});

test('pumpMux: 浏览正文（web_fetch）成功后抽黑话候选并落盘', async () => {
  const h = makeHarness();
  h.deps.extractTerms = () => ['新词'];
  const sid = keyedSession(h, 'sess-b', 'group:9');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'web_fetch', callId: 'c1', arguments: { url: 'https://x' } } }) };
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ text: '帖子正文：这个词好用' }] } } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.deps.browseLearnWindow.length, 1);
  assert.equal(h.count('upsertSlangEntry'), 1);
  assert.deepEqual(h.called('upsertSlangEntry')[0][1], '新词');
  assert.equal(h.called('upsertSlangEntry')[0][2].source, 'browse');
  assert.equal(h.count('saveSlang'), 1);
  assert.match(h.logText(), /\[browse-learn\] 从浏览正文抽到候选：新词/);
});

test('pumpMux: turn/end completed + 文本 → 自动转发到 QQ 并刷新状态', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-c', 'private:2');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '你好呀') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.count('turnDispatch.finish'), 1);
  assert.equal(h.count('flushReasoning'), 1);
  assert.equal(h.count('sendGuardCheckV2'), 1);
  const sends = h.called('sendToQQ');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], ['private:2', '你好呀']);
  assert.equal(h.count('appendActivity'), 1);
  assert.equal(h.deps.collectors.size, 0);
  assert.equal(h.deps.v2TurnStartAt.has(sid), false);
  assert.equal(h.deps.sendToolSucceededSessions.has(sid), false);
});

test('pumpMux: 纯 Markdown/空白输出按无文本处理，不发送', async () => {
  const h = makeHarness({ mdToPlain: () => '   ' });
  const sid = keyedSession(h, 'sess-md', 'private:2');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '### 标题') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('sendToQQ'), 0);
  assert.match(h.logText(), /agent 回复为空（仅格式\/空白）/);
});

test('pumpMux: 静默标记 / 发送工具已成功 / 静默模式拦截 → 都不自动转发', async () => {
  // 1) 静默标记
  {
    const h = makeHarness({ isSilentMarker: (text) => text === '[[SILENT]]' });
    const sid = keyedSession(h, 'sess-s1', 'group:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: said(sid, '[[SILENT]]') };
      yield { rpcId: 'r3', payload: endedWith(sid, completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('sendToQQ'), 0);
    assert.match(h.logText(), /AI 选择静默/);
  }
  // 2) 本回合发送工具已成功（必须在 turn/start 之后标记：turn/start 会清上回合标记）
  {
    const h = makeHarness();
    const sid = keyedSession(h, 'sess-s2', 'group:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      h.deps.sendToolSucceededSessions.add(sid);
      yield { rpcId: 'r2', payload: said(sid, '正文') };
      yield { rpcId: 'r3', payload: endedWith(sid, completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('sendToQQ'), 0);
    assert.match(h.logText(), /工具已发送消息，跳过自动转发/);
  }
  // 3) 静默模式拦截
  {
    const h = makeHarness({ shouldBlockSilentReply: () => true });
    const sid = keyedSession(h, 'sess-s3', 'group:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: said(sid, '正文') };
      yield { rpcId: 'r3', payload: endedWith(sid, completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('sendToQQ'), 0);
    assert.match(h.logText(), /静默模式，拦截在途回复/);
  }
});

test('pumpMux: 敏感回复被安全策略拦截并发通知', async () => {
  const h = makeHarness({ shouldAuditKey: () => true, SENSITIVE_RE: /SECRET_[A-Z]+/ });
  const sid = keyedSession(h, 'sess-sec', 'private:1');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '我的 SECRET_TOKEN 是 xyz') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('sendToQQ'), 0);
  assert.equal(h.count('sendNotice'), 1);
  assert.match(h.called('sendNotice')[0][1], /⚠️ 本条回复因疑似包含敏感信息/);
  assert.match(h.logText(), /回复被安全策略拦截/);
});

test('pumpMux: 社交模式多段发送走 sendBurstToQQ，单段走 sendToQQ', async () => {
  // 多段
  {
    const h = makeHarness({ isSocialEnabled: () => true, planSocialTimeline: () => ({ main: ['一', '二'] }) });
    const sid = keyedSession(h, 'sess-soc', 'group:7');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: said(sid, '一二') };
      yield { rpcId: 'r3', payload: endedWith(sid, completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('sendToQQ'), 0);
    const bursts = h.called('sendBurstToQQ');
    assert.equal(bursts.length, 1);
    assert.deepEqual(bursts[0][1], ['一', '二']);
    assert.deepEqual(bursts[0][2], h.deps.cfg.social);
    assert.ok(h.socialStates.get('group:7').lastActiveMessageAt > 0);
    assert.ok(h.socialStates.get('group:7').lastAiReplyAt > 0);
  }
  // 单段
  {
    const h = makeHarness({ isSocialEnabled: () => true, planSocialTimeline: () => ({ main: ['一句'] }) });
    const sid = keyedSession(h, 'sess-soc2', 'group:8');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: said(sid, '一句') };
      yield { rpcId: 'r3', payload: endedWith(sid, completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.deepEqual(h.called('sendToQQ')[0], ['group:8', '一句']);
    assert.equal(h.count('sendBurstToQQ'), 0);
  }
});

test('pumpMux: 发送失败（lastSendSucceeded=false）不刷新活跃时间', async () => {
  const h = makeHarness({ isSocialEnabled: () => true, lastSendSucceeded: () => false });
  const sid = keyedSession(h, 'sess-fail', 'group:3');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '发不出去') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  const st = h.socialStates.get('group:3');
  assert.equal(st.lastActiveMessageAt, undefined);
  assert.match(h.logText(), /本轮发言未送达/);
});

test('pumpMux: turn/end error → 通知；400/上下文超长还要退役会话', async () => {
  // 普通错误
  {
    const h = makeHarness();
    const sid = keyedSession(h, 'sess-err', 'private:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'error', error: { message: 'boom' } }) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.called('sendNotice')[0][1], '⚠️ agent 处理出错：boom');
    assert.equal(h.count('retireSession'), 0);
  }
  // 模型端 400：退役并重建
  {
    const h = makeHarness();
    const sid = keyedSession(h, 'sess-400', 'private:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'error', error: { message: 'Messages request failed (400)' } }) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.deepEqual(h.called('retireSession')[0], ['private:1']);
    assert.match(h.logText(), /\[SESSION-REBUILD\]/);
  }
});

test('pumpMux: 自动让位的 aborted 静默；用户主动 aborted 发「已停止」', async () => {
  // 自动取消
  {
    const h = makeHarness();
    const sid = keyedSession(h, 'sess-ab1', 'private:1');
    h.deps.autoCancelledKeys.add('private:1');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'aborted' }) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('sendToQQ'), 0);
    assert.equal(h.deps.autoCancelledKeys.has('private:1'), false);
    assert.match(h.logText(), /\[busy-watch\]/);
  }
  // 用户停止
  {
    const h = makeHarness();
    const sid = keyedSession(h, 'sess-ab2', 'private:2');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started(sid) };
      yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'aborted' }) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.deepEqual(h.called('sendToQQ')[0], ['private:2', '⏹️ 已停止']);
  }
});

test('pumpMux: completed 但无文本 → 只记静默，不发送', async () => {
  const h = makeHarness();
  const sid = keyedSession(h, 'sess-empty', 'private:1');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('sendToQQ'), 0);
  assert.equal(h.count('noteSilentTurnEndV2'), 1);
  assert.match(h.logText(), /回合完成但无文本/);
});

test('pumpMux: 话题被 blocked（会话已归档）→ 标记 isolatedDead 待重建', async () => {
  const h = makeHarness();
  const sid = 'sess-dead';
  h.deps.isolatedKindBySession.set(sid, 'ownlife');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'turn/end', data: { turn: 't1', reason: { kind: 'blocked' } } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.deps.isolatedDead.has('ownlife'), true);
  assert.equal(h.count('saveIsolatedDead'), 1);
  assert.match(h.logText(), /\[isolated\] ownlife 会话的回合被 blocked/);
});

// ── 无 key 会话：任务 / 念头 / 日记 / 群事实 / 门 / 学习 ──────────────────────

test('pumpMux: 任务会话收尾 → finishTask 回写 + 通知 + 成功轨迹 + 归档会话', async () => {
  const h = makeHarness({
    parseTaskResult: () => ({ outcome: 'success', evidence: '文件：a.txt', nextAction: '无' }),
  });
  const sid = 'task-sess';
  h.deps.taskSessions.add(sid);
  h.deps.taskPoolRunning.push({ sessionId: sid, taskId: 't-42', taskShort: '打扫房间', reportTo: 'private:1', acceptance: '' });
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '做完了\n【任务结果】成功｜证据：文件：a.txt｜下一步：无') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  const fin = h.called('finishTask');
  assert.equal(fin.length, 1);
  assert.equal(fin[0][0], 't-42');
  assert.equal(fin[0][1].outcome, 'success');
  assert.equal(fin[0][1].evidence, '文件：a.txt');
  assert.equal(fin[0][1].nextAction, '无');
  assert.equal(fin[0][1].bySessionId, sid);
  assert.match(fin[0][1].note, /做完了/);
  assert.equal(h.count('notifyTaskDone'), 1);
  assert.equal(h.called('notifyTaskDone')[0][3], true);
  assert.equal(h.count('appendTrace'), 1);
  assert.equal(h.called('appendTrace')[0][0].result, 'success');
  assert.equal(h.called('retireTaskSession')[0][0], sid);
  assert.equal(h.deps.taskSessions.has(sid), false);
});

test('pumpMux: 任务验收机检失败 → outcome 改 blocked，不写成功轨迹', async () => {
  const h = makeHarness({
    parseTaskResult: () => ({ outcome: 'success', evidence: '文件：out.txt', nextAction: '' }),
    checkVerify: async () => ({ ok: false, evidence: '找不到 out.txt' }),
  });
  const sid = 'task-check';
  h.deps.taskSessions.add(sid);
  h.deps.taskPoolRunning.push({ sessionId: sid, taskId: 't-9', taskShort: '导文件', reportTo: 'private:1', acceptance: '文件：out.txt' });
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '做完了\n【任务结果】成功｜证据：文件：out.txt｜下一步：无') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  const opts = h.called('finishTask')[0][1];
  assert.equal(opts.outcome, 'blocked');
  assert.match(opts.nextAction, /验收没过：找不到 out\.txt/);
  assert.equal(opts.evidence, '找不到 out.txt');
  assert.equal(h.called('notifyTaskDone')[0][3], false);
  assert.equal(h.count('appendTrace'), 0);
});

test('pumpMux: 工作台已 done 但没写结果行 → 用进度证据认 success', async () => {
  const h = makeHarness({
    parseTaskResult: () => null,
    workByTaskId: () => ({ id: 'w-1', status: 'done', progress: [{ note: '已保存截图' }] }),
  });
  const sid = 'work-sess';
  h.deps.taskSessions.add(sid);
  h.deps.taskPoolRunning.push({ sessionId: sid, taskId: 't-w', taskShort: '截图', reportTo: 'private:1', acceptance: '' });
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '干完了') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  const opts = h.called('finishTask')[0][1];
  assert.equal(opts.outcome, 'success');
  assert.equal(opts.evidence, '已保存截图');
  assert.equal(h.count('updateWorkById'), 1);
  assert.equal(h.called('updateWorkById')[0][0], 'w-1');
  assert.equal(h.called('setWorkStatus')[0][0], 'done');
  const next = h.called('updateWorkById.next')[0][0];
  assert.equal(next.status, 'done');
  assert.deepEqual(next.progress.map((p) => p.note).filter(Boolean), ['干完了']);
});

test('pumpMux: 反思会话产出 → FOCUS 落盘 + 记念头 + 反复想到进目标候选', async () => {
  const emitted = [];
  const h = makeHarness({
    parseFocusBlock: () => ({ focusNow: '把测试补完' }),
    extractThoughtLines: () => ['我要先把测试补完'],
    similarThoughtCount: () => 1,
    emitSelfThread: (...args) => { emitted.push(args); },
  });
  const sid = 'thought-sess';
  h.deps.thoughtSessions.add(sid);
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, '【FOCUS】\n我要先把测试补完') };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.count('saveFocusBlock'), 1);
  assert.match(h.logText(), /\[focus\] 重点块已存/);
  assert.deepEqual(h.called('appendThought')[0], ['reflect', '我要先把测试补完']);
  assert.equal(emitted.length, 1, 'reflect 产出应 emit 一次 self_thread.updated');
  assert.equal(emitted[0][0], '我要先把测试补完');
  assert.equal(h.count('addGoalIdea'), 1, 'prior=1 → 含这次共 2 次，应记目标候选');
  assert.equal(h.deps.lastThoughtTurn.kind, 'completed');
  assert.equal(h.deps.lastThoughtTurn.len, '【FOCUS】\n我要先把测试补完'.length);
});

test('pumpMux: 反思会话没产出 → 记 logAction(reflect, made:false)，不记念头', async () => {
  const h = makeHarness();
  const sid = 'thought-empty';
  h.deps.thoughtSessions.add(sid);
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'error', error: { message: 'x' } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  const acts = h.called('logAction');
  assert.equal(acts.length, 1);
  assert.equal(acts[0][0].t, 'reflect');
  assert.equal(acts[0][0].made, false);
  assert.equal(acts[0][0].why, 'no-output:error');
  assert.equal(h.count('appendThought'), 0);
});

test('pumpMux: 日记会话 completed 且 ≥50 字 → 落盘日记', async () => {
  const h = makeHarness();
  const sid = 'diary-sess';
  h.deps.diarySessions.set(sid, '2026-11-02');
  const text = '日'.repeat(60);
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: said(sid, text) };
    yield { rpcId: 'r3', payload: endedWith(sid, completed) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.deepEqual(h.called('appendDailyDiary')[0], ['2026-11-02', text]);
  assert.equal(h.deps.diarySessions.has(sid), false);
  assert.match(h.logText(), /的日记已写好/);
});

test('pumpMux: 日记会话没产出 → 记失败原因，不落盘', async () => {
  const h = makeHarness();
  const sid = 'diary-fail';
  h.deps.diarySessions.set(sid, '2026-11-02');
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started(sid) };
    yield { rpcId: 'r2', payload: endedWith(sid, { kind: 'aborted' }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('appendDailyDiary'), 0);
  const act = h.called('logAction')[0][0];
  assert.equal(act.t, 'diary');
  assert.equal(act.made, false);
  assert.equal(act.why, 'no-output:aborted');
});

test('pumpMux: 群事实会话 → waiter 在 completed 时 resolve，失败时 reject', async () => {
  const h = makeHarness();
  const resolved = [];
  const rejected = [];
  h.deps.groupFactSessions.add('fact-ok');
  h.deps.groupFactSessions.add('fact-bad');
  h.deps.groupFactWaiters.set('fact-ok', [{ resolve: (v) => resolved.push(v), reject: (e) => rejected.push(['ok', e]), timer: null }]);
  h.deps.groupFactWaiters.set('fact-bad', [{ resolve: (v) => resolved.push(v), reject: (e) => rejected.push(['bad', e]), timer: null }]);
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started('fact-ok') };
    yield { rpcId: 'r2', payload: said('fact-ok', '群事实 JSON') };
    yield { rpcId: 'r3', payload: endedWith('fact-ok', completed) };
    yield { rpcId: 'r4', payload: started('fact-bad') };
    yield { rpcId: 'r5', payload: endedWith('fact-bad', { kind: 'error', error: { message: 'x' } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.deepEqual(resolved, ['群事实 JSON']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0][0], 'bad');
  assert.match(String(rejected[0][1].message), /群事实 turn 未完成：error/);
  assert.equal(h.deps.groupFactWaiters.size, 0);
  assert.equal(h.deps.groupFactSessions.size, 0);
});

test('pumpMux: 注意门会话 → 有批次走 applyGateHits，无批次留门日志', async () => {
  // 有批次
  {
    const h = makeHarness({ parseGateReply: () => ({ hits: ['有人叫我'] }) });
    h.deps.gateSessions.add('gate-hit');
    h.deps.gateBatches.set('gate-hit', { key: 'group:5', msgs: [{ seq: 1 }] });
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started('gate-hit') };
      yield { rpcId: 'r2', payload: said('gate-hit', '判定 JSON') };
      yield { rpcId: 'r3', payload: endedWith('gate-hit', completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    const applied = h.called('applyGateHits');
    assert.equal(applied.length, 1);
    assert.equal(applied[0][0].key, 'group:5');
    assert.deepEqual(applied[0][0].hits, ['有人叫我']);
    assert.equal(applied[0][0].raw, '判定 JSON');
    assert.equal(applied[0][0].source, 'flash');
    assert.equal(h.deps.gateBatches.has('gate-hit'), false);
    assert.equal(h.deps.gateSessions.has('gate-hit'), false);
  }
  // 无批次
  {
    const h = makeHarness({ parseGateReply: () => ({ hits: [] }) });
    h.deps.gateSessions.add('gate-log');
    h.deps.api.events.mux = async function* () {
      yield { rpcId: 'r1', payload: started('gate-log') };
      yield { rpcId: 'r2', payload: said('gate-log', '空判定') };
      yield { rpcId: 'r3', payload: endedWith('gate-log', completed) };
    };
    assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
    assert.equal(h.count('applyGateHits'), 0);
    const logRow = h.called('appendGateLog')[0][0];
    assert.equal(logRow.key, null);
    assert.equal(logRow.stage, 2);
    assert.equal(logRow.completed, true);
    assert.equal(logRow.hits, 0);
    assert.equal(logRow.raw, '空判定');
  }
});

test('pumpMux: 黑话学习会话 → completed 文本 resolve，失败 reject 并带 reason 全文', async () => {
  const h = makeHarness();
  h.deps.slangLearnerSessionId = 'learner-keep';
  h.deps.learnerSessions.add('learner-keep');
  h.deps.learnerSessions.add('learner-temp');
  const resolved = [];
  const rejected = [];
  h.deps.learnerWaiters.set('learner-keep', [{ resolve: (v) => resolved.push(v), reject: (e) => rejected.push(e), timer: null }]);
  h.deps.learnerWaiters.set('learner-temp', [{ resolve: (v) => resolved.push(v), reject: (e) => rejected.push(e), timer: null }]);
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: started('learner-keep') };
    yield { rpcId: 'r2', payload: said('learner-keep', '学到的黑话') };
    yield { rpcId: 'r3', payload: endedWith('learner-keep', completed) };
    yield { rpcId: 'r4', payload: started('learner-temp') };
    yield { rpcId: 'r5', payload: endedWith('learner-temp', { kind: 'error', error: { message: 'model down' } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.deepEqual(resolved, ['学到的黑话']);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].message), /学习会话 turn 未正常完成：error/);
  assert.match(String(rejected[0].message), /model down/);
  assert.equal(h.deps.learnerSessions.has('learner-keep'), true, 'slangLearnerSessionId 保留');
  assert.equal(h.deps.learnerSessions.has('learner-temp'), false, '旧学习会话结束后移除');
  assert.equal(h.deps.learnerWaiters.size, 0);
});

test('pumpMux: 无 key 会话的 tool/call/result 也留痕（不因无 key 蒸发）', async () => {
  const h = makeHarness();
  const sid = 'nokey-sess';
  h.deps.api.events.mux = async function* () {
    yield { rpcId: 'r1', payload: ev(sid, { type: 'tool/call', data: { name: 'web_search', callId: 'c1', arguments: '{"q":"x"}' } }) };
    yield { rpcId: 'r2', payload: ev(sid, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ text: '浏览结果' }] } } }) };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(h.count('appendToolLog'), 2);
  assert.equal(h.called('appendToolLog')[0][0].key, '');
  assert.equal(h.count('noteBrowse'), 1);
  assert.equal(h.called('newBrowseEntry')[0][0].arg, '{"q":"x"}');
  assert.equal(h.called('newBrowseEntry')[0][0].head, '浏览结果');
  // 无 key 会话的 tool/result 失败要走 noteDeviceFailure
  assert.equal(h.count('noteDeviceFailure'), 0);
});

// ── 流生命周期 ──────────────────────────────────────────────────────────────

test('pumpMux: 事件流断开 → 记「事件流中断」并清空旧 turn 状态后重连', async () => {
  const h = makeHarness();
  h.deps.api.events.mux = async function* () { throw new Error('ws down'); };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.match(h.logText(), /事件流中断: ws down/);
  assert.equal(h.count('clearAllPendingWakeLeases'), 1);
});

test('pumpMux: finally 清空全部易残留状态（重连不重复累加）', async () => {
  const h = makeHarness();
  h.deps.collectors.set('s', {});
  h.deps.social.silentTurns.set('k', []);
  h.deps.sendToolSucceededSessions.add('s');
  h.deps.pendingSendToolCalls.set('s', new Set(['c']));
  h.deps.v2TurnStartAt.set('s', 1);
  h.deps.busySinceMs.set('s', 1);
  h.deps.toolCallNames.set('s', new Map([['c', 'x']]));
  h.deps.pendingWakeKeys.add('k');
  h.deps.social.exitingSessions.add('s');
  h.deps.wakeConfigUpdatedKeys.add('k');
  h.deps.markReadCalledKeys.add('k');
  h.deps.wakeConfigMissCount.set('k', 1);
  h.deps.activeWaits.set('k', {});
  h.deps.api.events.mux = async function* () {};
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);

  assert.equal(h.deps.collectors.size, 0);
  assert.equal(h.deps.social.silentTurns.size, 0);
  assert.equal(h.deps.sendToolSucceededSessions.size, 0);
  assert.equal(h.deps.pendingSendToolCalls.size, 0);
  assert.equal(h.deps.v2TurnStartAt.size, 0);
  assert.equal(h.deps.busySinceMs.size, 0);
  assert.equal(h.deps.toolCallNames.size, 0);
  assert.equal(h.deps.pendingWakeKeys.size, 0);
  assert.equal(h.deps.social.exitingSessions.size, 0);
  assert.equal(h.deps.wakeConfigUpdatedKeys.size, 0);
  assert.equal(h.deps.markReadCalledKeys.size, 0);
  assert.equal(h.deps.wakeConfigMissCount.size, 0);
  assert.equal(h.deps.activeWaits.size, 0);
  assert.equal(h.count('clearAllPendingWakeLeases'), 1);
});

test('pumpMux: 流结束后 sleep 重连，第二趟继续消费（无限泵）', async () => {
  const h = makeHarness();
  let muxCalls = 0;
  let sleeps = 0;
  h.deps.sleep = async () => {
    sleeps += 1;
    if (sleeps >= 2) throw STOP;
  };
  h.deps.api.events.mux = async function* () {
    muxCalls += 1;
    yield { rpcId: `r-${muxCalls}`, payload: { type: 'stream/error', error: { code: `e${muxCalls}` } } };
  };
  assert.equal(await pumpMux(h.deps).then(() => null, (e) => e), STOP);
  assert.equal(muxCalls, 2);
  assert.match(h.logText(), /e1/);
  assert.match(h.logText(), /e2/);
});
