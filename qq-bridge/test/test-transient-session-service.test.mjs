// transient-session-service 金标：工作区只建一次、隔离会话的恢复/重建/失效、归档与恢复、会话清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransientSession } from '../src/domain/conversation/transient-session-service.mjs';

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tss-'));
  const state = {
    logs: [], created: [], archived: [], selected: [], renamed: [], writes: [],
    isolated: new Map(), kindBySession: new Map(), dead: new Set(), timers: new Map(),
  };
  const api = {
    workspace: {
      create: async ({ path: p }) => ({ result: { ok: true, value: { workspace: { workspaceId: `ws:${path.basename(p)}` } } } }),
      rename: async (payload) => { state.renamed.push(payload); return { result: { ok: true, value: {} } }; },
      archiveSession: async (payload) => { state.archived.push(payload.sessionId); return { result: { ok: true, value: {} } }; },
    },
    sessions: {
      create: async (payload) => {
        state.created.push(payload);
        const id = `sess-${state.created.length}`;
        return { result: { ok: true, value: { sessionId: id } } };
      },
      selectModel: async (payload) => { state.selected.push(payload); return { result: { ok: true, value: {} } }; },
    },
    callUnary: async (method, payload) => { state.renamed.push({ method, ...payload }); return { result: { ok: true, value: {} } }; },
  };
  const ctxState = { sessions: {}, sessionPolicies: {} };
  const svc = createTransientSession({
    fs, path, log: (m) => state.logs.push(String(m)),
    cfg: { sessionCwd: dir, workspaceTitle: 'QQ 聊天' },
    STATE_DIR: path.join(dir, 'state'),
    STATE_DATA_DIR: path.join(dir, 'state', 'data'),
    getApi: () => api,
    unwrap: (r, label) => { if (!r?.result?.ok) throw new Error(`${label} failed`); return r.result.value; },
    atomicWriteJson: (file, value) => {
      state.writes.push({ file, value });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    },
    ensureChatModel: async (sid) => { state.chatModel = sid; },
    isolatedPresetFor: (kind) => (kind === 'gate' ? 'qq-gate' : 'qq-chat-v2'),
    isolatedStatePath: (kind) => path.join(dir, 'state', `${kind}.json`),
    loadBrowse: () => ({}), loadWorks: () => ({}),
    recordSessionKind: (sid, kind) => { state.kindBySession.set(sid, kind); },
    saveIsolatedDead: () => { state.deadSaved = true; },
    saveState: () => { state.stateSaved = true; },
    isolatedSessions: state.isolated,
    transientArchiveTimers: state.timers,
    sessionKinds: {},
    state: ctxState,
    getSocialV2: () => ({ conversations: new Map() }),
    getDshReady: () => true,
    learnerSessions: new Set(),
    SLANG_SESSION_FILE: path.join(dir, 'state', 'slang-session.json'),
    getSlangLearnerSessionId: () => null,
    setSlangLearnerSessionId: () => {},
    getCfgRef: () => ({ gate: { model: { provider: 'p', model: 'deepseek-flash' } } }),
    isolatedKindBySession: state.kindBySession,
    TRANSIENT_IDLE_MS: 5 * 60 * 1000,
    isolatedDead: state.dead,
    getDshPresetIds: () => ['qq-chat-v2', 'qq-gate'],
    ...overrides,
  });
  return { svc, state, ctxState, dir, api };
}

test('ensureHerWorkspace：同一个工作区只建一次，标题会被设置', async () => {
  const h = makeCtx();
  const a = await h.svc.ensureHerWorkspace();
  const b = await h.svc.ensureHerWorkspace();
  assert.equal(a, b);
  assert.equal(h.state.created.length, 0, '建工作区不建会话');
  assert.ok(h.state.renamed.some((r) => r.title === 'QQ 聊天'));
});

test('ensureHerWorkspace：创建失败不留半成品，下次还能重试', async () => {
  let fail = true;
  const h = makeCtx({
    getApi: () => ({
      workspace: {
        create: async () => {
          if (fail) throw new Error('DSH 没起来');
          return { result: { ok: true, value: { workspace: { workspaceId: 'ws:ok' } } } };
        },
        rename: async () => ({ result: { ok: true, value: {} } }),
      },
    }),
  });
  await assert.rejects(() => h.svc.ensureHerWorkspace(), /DSH 没起来/);
  fail = false;
  assert.equal(await h.svc.ensureHerWorkspace(), 'ws:ok');
});

test('ensureIsolatedSession：缓存命中直接复用，不重复建会话', async () => {
  const h = makeCtx();
  h.state.isolated.set('intake', 'sess-cached');
  assert.equal(await h.svc.ensureIsolatedSession('intake'), 'sess-cached');
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.kindBySession.get('sess-cached'), 'intake');
});

test('ensureIsolatedSession：磁盘上有同工作区同 preset 的会话就恢复它', async () => {
  const h = makeCtx();
  const ws = await h.svc.ensureHerWorkspace();
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'intake.json'), JSON.stringify({ sessionId: 'sess-old', preset: 'qq-chat-v2', workspaceId: ws }));
  assert.equal(await h.svc.ensureIsolatedSession('intake'), 'sess-old');
  assert.equal(h.state.created.length, 0, '不该新建');
  assert.equal(h.state.archived.length, 0);
});

test('ensureIsolatedSession：preset 或工作区不一致 → 归档旧的再新建', async () => {
  const h = makeCtx();
  const ws = await h.svc.ensureHerWorkspace();
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'intake.json'), JSON.stringify({ sessionId: 'sess-bad', preset: 'standard', workspaceId: ws }));
  const sid = await h.svc.ensureIsolatedSession('intake');
  assert.equal(sid, 'sess-1');
  assert.deepEqual(h.state.archived, ['sess-bad']);

  const h2 = makeCtx();
  await h2.svc.ensureHerWorkspace();
  fs.mkdirSync(path.join(h2.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h2.dir, 'state', 'ownlife.json'), JSON.stringify({ sessionId: 'sess-other-ws', preset: 'qq-chat-v2', workspaceId: 'ws:别的' }));
  assert.equal(await h2.svc.ensureIsolatedSession('ownlife'), 'sess-1');
  assert.deepEqual(h2.state.archived, ['sess-other-ws']);
});

test('ensureIsolatedSession：新建时选模型、改名、落盘状态、清掉已死标记', async () => {
  const h = makeCtx();
  h.state.dead.add('intake');
  const sid = await h.svc.ensureIsolatedSession('intake');
  assert.equal(sid, 'sess-1');
  assert.equal(h.state.created[0].agentPreset, 'qq-chat-v2');
  assert.equal(h.state.chatModel, 'sess-1', '非 gate 走 ensureChatModel');
  assert.equal(h.state.dead.has('intake'), false, '新建成功 = 这个 kind 活了');
  assert.equal(h.state.deadSaved, true);
  const written = h.state.writes.find((w) => w.file.endsWith('intake.json'));
  assert.equal(written.value.preset, 'qq-chat-v2');
  assert.equal(h.state.kindBySession.get('sess-1'), 'intake', '要登记会话 kind（临时保留期）');
  assert.ok(h.state.logs.some((l) => l.includes('独立会话已创建')));
});

test('ensureIsolatedSession：gate 缺 qq-gate preset 时 fail-closed', async () => {
  const h = makeCtx({ getDshPresetIds: () => ['qq-chat-v2'] });
  await assert.rejects(() => h.svc.ensureIsolatedSession('gate'), /qq-gate preset 不可用/);
  assert.equal(h.state.created.length, 0, '不能偷偷用别的 preset 建门会话');
  assert.ok(h.state.logs.some((l) => l.includes('qq-gate preset 不可用')));
});

test('ensureIsolatedSession：gate 用 flash + low，不走 ensureChatModel', async () => {
  const h = makeCtx();
  const sid = await h.svc.ensureIsolatedSession('gate');
  assert.equal(sid, 'sess-1');
  const sel = h.state.selected.find((s) => s.sessionId === 'sess-1');
  assert.equal(sel.model, 'deepseek-flash');
  assert.equal(sel.reasoningEffort, 'low');
  assert.equal(h.state.chatModel, undefined, 'gate 不该跟着主模型走');
});

test('ensureIsolatedSession：force 会归档旧 id 并重建', async () => {
  const h = makeCtx();
  h.state.isolated.set('intake', 'sess-cached');
  const sid = await h.svc.ensureIsolatedSession('intake', { force: true });
  assert.equal(sid, 'sess-1');
  assert.notEqual(sid, 'sess-cached');
  assert.equal(h.state.kindBySession.get('sess-cached'), undefined);
});

test('归档记录：写入/去重/删除；到点归档会清理缓存与状态文件', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx();
  h.state.isolated.set('intake', 'sess-1');
  h.state.kindBySession.set('sess-1', 'intake');
  h.svc.noteTransientArchive('intake', 'sess-1', Date.now() + 1000);
  assert.equal(h.svc.readTransientArchives().length, 1);
  h.svc.scheduleTransientArchiveAt('sess-1', 'intake', Date.now() + 1000);
  assert.equal(h.state.timers.size, 1);
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.state.archived, ['sess-1']);
  assert.equal(h.state.isolated.has('intake'), false, '归档要清缓存');
  assert.equal(h.svc.readTransientArchives().length, 0, '归档记录也要删掉');
  assert.ok(h.state.logs.some((l) => l.includes('临时会话已归档')));
});

test('cancelTransientArchive：取消计时器并删归档记录', () => {
  const h = makeCtx();
  h.svc.noteTransientArchive('intake', 'sess-1', Date.now() + 100000);
  h.svc.scheduleTransientArchiveAt('sess-1', 'intake', Date.now() + 100000);
  h.svc.cancelTransientArchive('sess-1');
  assert.equal(h.state.timers.size, 0);
  assert.equal(h.svc.readTransientArchives().length, 0);
});

test('restoreTransientArchives：过期的立刻归档，没到点的重新挂计时器', async () => {
  const h = makeCtx();
  h.svc.writeTransientArchives([
    { kind: 'intake', sessionId: 'expired', archiveAt: Date.now() - 1000 },
    { kind: 'ownlife', sessionId: 'future', archiveAt: Date.now() + 60_000 },
  ]);
  h.svc.restoreTransientArchives();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.state.archived, ['expired']);
  assert.equal(h.state.timers.size, 1, '未到点的要重挂');
  h.svc.cancelTransientArchive('future');
});

test('pruneMissingSessions：DSH 工作区里没有的会话映射要清掉', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-home-'));
  fs.mkdirSync(path.join(home, '.dsh', 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dsh', 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { sessionIds: ['sid-live'] } } },
  }));
  const prev = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const h = makeCtx();
    h.ctxState.sessions = { 'group:1': 'sid-live', 'group:2': 'sid-gone' };
    h.ctxState.sessionPolicies = { 'group:1': 'p', 'group:2': 'p' };
    await h.svc.pruneMissingSessions();
    assert.deepEqual(Object.keys(h.ctxState.sessions), ['group:1']);
    assert.deepEqual(Object.keys(h.ctxState.sessionPolicies), ['group:1']);
    assert.equal(h.state.stateSaved, true);
    assert.ok(h.state.logs.some((l) => l.includes('会话映射失效')));
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev;
  }
});

test('pruneMissingSessions：读不到工作区文件就安静返回（不误删任何映射）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-home2-'));
  const prev = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const h = makeCtx();
    h.ctxState.sessions = { 'group:1': 'sid-live' };
    await h.svc.pruneMissingSessions();
    assert.deepEqual(Object.keys(h.ctxState.sessions), ['group:1']);
    assert.equal(h.state.stateSaved, undefined);
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev;
  }
});
