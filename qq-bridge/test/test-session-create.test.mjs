// session-create 金标：复用/退役重建/not-found 重建/preset fail-closed/工作区恢复/代际竞态保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCreate } from '../src/domain/conversation/session-create.mjs';

function makeCtx(overrides = {}) {
  const state = { sessions: {}, sessionPolicies: {} };
  const out = { logs: [], retired: [], created: [], archived: [], followed: [], saves: 0, policies: new Map() };
  let epoch = 1;
  let mode = overrides.mode ?? 'reserved2';
  let presets = overrides.presets ?? ['qq-chat-v2', 'qq-chat-admin'];
  const sessionPromises = new Map();
  const reverse = new Map();
  const svc = createSessionCreate({
    getState: () => state,
    getSessionEpoch: () => epoch,
    getCfg: () => ({ ownerQQ: 10001, agentPreset: 'qq-chat', socialV2: { agentPreset: 'qq-chat-v2' } }),
    getCurrentMode: () => mode,
    getDshPresetIds: () => presets,
    sessionPolicy: (key) => overrides.policy ?? `pol:${key}`,
    isSessionAllowedInCurrentMode: () => overrides.allowed ?? true,
    isCurrentSession: (key, sid) => (overrides.isCurrent ? overrides.isCurrent(key, sid) : state.sessions[key] === sid && state.sessionPolicies[key] === (overrides.policy ?? `pol:${key}`)),
    retireSession: (key) => {
      out.retired.push(key);
      delete state.sessions[key];
      delete state.sessionPolicies[key];
    },
    ensureChatModel: async (sid) => (overrides.chatModel ?? (() => 'applied'))(sid),
    ensureHerWorkspace: async () => 'ws-1',
    resetHerWorkspace: () => { out.resetWs = true; },
    modePreset: (key, m, cfg) => (overrides.preset === undefined ? 'qq-chat-v2' : overrides.preset),
    api: {
      sessions: {
        create: async (params) => {
          out.created.push(params);
          if (overrides.createFails?.(out.created.length, params)) throw new Error(overrides.createError ?? 'create failed');
          return { result: { ok: true, value: { sessionId: `sess-${out.created.length}` } } };
        },
      },
      workspace: { archiveSession: async ({ sessionId }) => { out.archived.push(sessionId); } },
      events: { follow: (sid) => out.followed.push(sid) },
    },
    unwrap: (r, label) => { if (!r?.result?.ok) throw new Error(`${label} failed`); return r.result.value; },
    log: (m) => out.logs.push(String(m)),
    sessionPromises,
    reverse,
    laneBaseKey: (key) => key.replace(/#owner$/, ''),
    saveState: () => { out.saves += 1; },
    ...overrides.ctxExtra,
  });
  return {
    svc, out, state, sessionPromises, reverse,
    setMode: (m) => { mode = m; },
    setPresets: (p) => { presets = p; },
    bumpEpoch: () => { epoch += 1; },
  };
}

test('ensureSession：当前模式不允许就直接拒绝', async () => {
  const h = makeCtx({ allowed: false });
  await assert.rejects(() => h.svc.ensureSession('group:1'), /当前模式不允许会话/);
  assert.equal(h.out.created.length, 0);
});

test('ensureSession：已有且代际一致的会话直接复用，只确认模型', async () => {
  const h = makeCtx();
  h.state.sessions['group:1'] = 'sess-old';
  h.state.sessionPolicies['group:1'] = 'pol:group:1';
  assert.equal(await h.svc.ensureSession('group:1'), 'sess-old');
  assert.deepEqual(h.out.retired, []);
  assert.equal(h.out.created.length, 0);
  assert.equal(h.out.chatModel, undefined);
});

test('ensureSession：旧会话代际不匹配 → 先退役再建新的', async () => {
  const h = makeCtx();
  h.state.sessions['group:1'] = 'sess-stale';
  h.state.sessionPolicies['group:1'] = '旧的策略';
  assert.equal(await h.svc.ensureSession('group:1'), 'sess-1');
  assert.deepEqual(h.out.retired, ['group:1']);
  assert.equal(h.state.sessions['group:1'], 'sess-1');
  assert.equal(h.state.sessionPolicies['group:1'], 'pol:group:1');
  assert.deepEqual(h.reverse.get('sess-1'), 'group:1');
  assert.equal(h.out.saves, 1);
  assert.deepEqual(h.out.followed, ['sess-1'], '新会话要显式 follow，否则收不到 turn 事件');
});

test('ensureSession：DSH 侧 not-found → 退役本地映射并在本次调用中重建', async () => {
  const h = makeCtx({ chatModel: () => 'not-found' });
  h.state.sessions['group:1'] = 'sess-gone';
  h.state.sessionPolicies['group:1'] = 'pol:group:1';
  assert.equal(await h.svc.ensureSession('group:1'), 'sess-1');
  assert.deepEqual(h.out.retired, ['group:1']);
  assert.ok(h.out.logs.some((l) => l.includes('在 DSH 侧已不存在')));
});

test('ensureSession：严格模式拿不到 preset 时 fail-closed，不建「无 preset」会话', async () => {
  const h = makeCtx({ preset: '' }); // 空串 = 严格模式下拿不到可用 preset
  await assert.rejects(() => h.svc.ensureSession('group:1'), /拒绝为 group:1 创建会话/);
  assert.equal(h.out.created.length, 0, '绝不能创建会被 DSH 套默认 preset 的会话');
});

test('ensureSession：closed-agent 允许降级为无 preset 会话（仅 owner 私聊）', async () => {
  const h = makeCtx({ mode: 'closed-agent', preset: 'qq-chat' });
  h.setMode('closed-agent');
  const sid = await h.svc.ensureSession('private:10001');
  assert.ok(sid);
  assert.equal(h.out.created.length, 1);
  assert.equal(h.out.created[0].agentPreset, 'qq-chat');
});

test('ensureSession：预设挂不上但有 error 时按 closed-agent 降级尝试第二次', async () => {
  const h = makeCtx({
    mode: 'closed-agent',
    preset: 'qq-chat',
    createFails: (n) => n === 1,
    createError: 'preset not found',
  });
  h.setMode('closed-agent');
  const sid = await h.svc.ensureSession('private:1');
  assert.ok(sid);
  assert.equal(h.out.created.length, 2);
  assert.equal(h.out.created[1].agentPreset, undefined, '第二次不带 preset（只有 closed-agent 能走）');
  assert.ok(h.out.logs.some((l) => l.includes('已降级为无 preset 会话')));
});

test('ensureSession：工作区失效时重建并重试一次', async () => {
  const h = makeCtx({ createFails: (n) => n === 1, createError: 'workspace not found' });
  const sid = await h.svc.ensureSession('group:1');
  assert.ok(sid);
  assert.equal(h.out.resetWs, true);
  assert.equal(h.out.created.length, 2);
  assert.ok(h.out.logs.some((l) => l.includes('[ws-recover]')));
});

test('ensureSession：创建期间被 reset（epoch 变了）→ 归档新会话并抛错，不写映射', async () => {
  const h = makeCtx({ ctxExtra: {} });
  const orig = h.svc.ensureSession;
  const p = orig.call(h.svc, 'group:1');
  h.bumpEpoch();
  await assert.rejects(() => p, /会话创建期间已重置/);
  assert.deepEqual(h.out.archived, ['sess-1']);
  assert.equal(h.state.sessions['group:1'], undefined);
});

test('ensureSession：并发调用共用同一个创建 promise，只建一次', async () => {
  const h = makeCtx();
  const [a, b] = await Promise.all([h.svc.ensureSession('group:1'), h.svc.ensureSession('group:1')]);
  assert.equal(a, b);
  assert.equal(h.out.created.length, 1);
  assert.equal(h.sessionPromises.size, 0, '结束后不能留着 promise');
});

test('ensureSession：完全建不出来时给出可操作错误（绝不退化成默认 preset）', async () => {
  const h = makeCtx({ createFails: () => true, createError: 'permission denied' });
  await assert.rejects(() => h.svc.ensureSession('group:1'), /无法为 group:1 创建 DSH 会话.*已拒绝退化为 DSH 默认 preset/s);
});
