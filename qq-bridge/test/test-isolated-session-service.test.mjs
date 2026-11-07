// isolated-session-service 的金标：投递前置、上下文拼装、日记发起与跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedSession } from '../src/domain/conversation/isolated-session-service.mjs';

function ctx(overrides = {}) {
  const calls = { ensure: [], submit: [], follow: [], notices: [], logAction: [] };
  const conversations = new Map([['group:1', {}]]);
  const diarySessions = new Map();
  const thoughtSessions = new Set();
  const thoughtCollectors = new Map();
  const taskSessions = new Set();
  const taskCollectors = new Map();
  const isolatedDead = new Set();
  const state = { dsh: true, life: { state: 'awake' }, written: false, attempts: 0, submitOk: true, knowledge: '', groupWindow: '' };
  const base = {
    cfg: { ownerQQ: 123, socialV2: { diary: {} } },
    log: () => {},
    getSocialV2: () => ({ conversations }),
    getSocialV2State: () => ({}),
    readRoleState: () => ({ role: '测试角色' }),
    roleHintForMode: () => 'role-card',
    getIsSessionAllowedInCurrentMode: () => true,
    renderConversations: () => 'conversations',
    getDshReady: () => state.dsh,
    yieldToConversations: async () => {},
    isolatedDead,
    ensureIsolatedSession: async (kind, opts) => { calls.ensure.push({ kind, opts }); return `sid-${kind}`; },
    ensureChatModel: async () => {},
    buildWakePromptV2: () => 'wake-prompt',
    stripKnownTokens: (text) => ({ text, hits: 0 }),
    collectSessionTokens: () => [],
    promptTextOf: (packet) => `packet:${packet.content}`,
    buildContextPacket: (o) => o,
    groupReadWindowText: () => state.groupWindow,
    getSelfKnowledgeBlock: () => state.knowledge,
    acquireTurnSlot: async () => ({ slot: 1 }),
    bindTurnGrant: () => {},
    submitPromptWithTurnSlot: async (payload) => {
      calls.submit.push(payload);
      return { result: state.submitOk ? { ok: true } : { ok: false, error: { code: 'x', message: 'rejected' } } };
    },
    getApi: () => ({ events: { follow: (sid) => calls.follow.push(sid) } }),
    thoughtSessions,
    thoughtCollectors,
    taskSessions,
    taskCollectors,
    stateWithKey: () => ({}),
    saveSocialV2State: () => {},
    getLifeState: () => state.life,
    todayDiaryWritten: () => state.written,
    diaryAttempts: () => state.attempts,
    bumpDiaryAttempts: () => { state.attempts += 1; },
    logAction: (row) => calls.logAction.push(row),
    readJsonlSafe: () => [],
    MEM_DIR: '/mem',
    stateDataPath: (p) => `/state/${p}`,
    renderReflectLine: () => '',
    loadLessons: () => [],
    loadGoals: () => [],
    diarySessions,
    createTurnCollector: () => ({ collector: true }),
  };
  Object.assign(base, overrides);
  return { svc: createIsolatedSession(base), calls, state, conversations, diarySessions, thoughtSessions };
}

test('deliverToIsolated：DSH 未就绪直接抛错', async () => {
  const h = ctx();
  h.state.dsh = false;
  await assert.rejects(h.svc.deliverToIsolated('ownlife', 'x'), /DSH 未就绪/);
});

test('deliverToIsolated：ownlife 拼背景+群窗+自我认知，并 follow', async () => {
  const h = ctx();
  h.state.groupWindow = 'group-window';
  h.state.knowledge = 'self-knowledge';
  const r = await h.svc.deliverToIsolated('ownlife', '任务文本', { key: 'group:1', reason: 'own-life' });
  assert.equal(r.ok, true);
  const text = h.calls.submit[0].content[0].text;
  assert.match(text, /self-knowledge/);
  assert.match(text, /group-window/);
  assert.match(text, /任务文本/);
  assert.equal(h.thoughtSessions.has('sid-ownlife'), true);
  assert.deepEqual(h.calls.follow, ['sid-ownlife']);
});

test('deliverToIsolated：task 拿完整唤醒上下文', async () => {
  const h = ctx();
  await h.svc.deliverToIsolated('task', '任务文本', { key: 'group:1', reason: 'task' });
  assert.match(h.calls.submit[0].content[0].text, /^wake-prompt/);
});

test('deliverToIsolated：投递被拒抛错', async () => {
  const h = ctx();
  h.state.submitOk = false;
  await assert.rejects(h.svc.deliverToIsolated('diary', 'x', { key: 'private:123' }), /prompt 被拒/);
});

test('startDiarySession：睡着且非 force 跳过', async () => {
  const h = ctx();
  h.state.life = { state: 'sleep' };
  await h.svc.startDiarySession('2026-11-02');
  assert.equal(h.calls.ensure.length, 0);
  assert.equal(h.calls.logAction[0].why, 'asleep');
});

test('startDiarySession：已写过/超次数跳过', async () => {
  const h = ctx();
  h.state.written = true;
  await h.svc.startDiarySession('2026-11-02');
  assert.equal(h.calls.ensure.length, 0);
  h.state.written = false;
  h.state.attempts = 2;
  await h.svc.startDiarySession('2026-11-02');
  assert.equal(h.calls.ensure.length, 0);
  assert.equal(h.calls.logAction.at(-1).why, 'attempt-cap');
});

test('startDiarySession：正常发起，登记 diarySessions 与 prompt 素材', async () => {
  const h = ctx();
  await h.svc.startDiarySession();
  assert.equal(h.calls.ensure[0].kind, 'diary');
  assert.equal(h.diarySessions.size, 1);
  const text = h.calls.submit[0].content[0].text;
  assert.match(text, /今天的日记/);
  assert.match(text, /今天很安静/);
});

test('deliverToIsolated：follow 必须先于 submit（否则 60s 空转回收槽位）', async () => {
  const order = [];
  const h = ctx({
    getApi: () => ({ events: { follow: () => order.push('follow') } }),
    submitPromptWithTurnSlot: async () => { order.push('submit'); return { result: { ok: true } }; },
  });
  await h.svc.deliverToIsolated('ownlife', 'x', { key: 'group:1', reason: 'own-life' });
  assert.deepEqual(order, ['follow', 'submit']);
});
