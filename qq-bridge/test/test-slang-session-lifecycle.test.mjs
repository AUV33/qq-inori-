// slang-session-lifecycle 金标：学习会话的 preset fail-closed、旧记录失效、复用与新建、归档旧会话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlangSessionLifecycle } from '../src/domain/social/slang-session-lifecycle.mjs';

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-slanglc-'));
  const state = { logs: [], created: [], archived: [], followed: [], kinds: [], wrote: [], chatModel: [] };
  const learnerSessions = new Set();
  const learnerWaiters = new Map();
  const learnerCollectors = new Map();
  let learnerId = overrides.initialId ?? null;
  const svc = createSlangSessionLifecycle({
    log: (m) => state.logs.push(String(m)),
    fs, cfg: { agentPreset: 'qq-chat', slang: {} },
    STATE_DIR: path.join(dir, 'state'),
    SLANG_SESSION_FILE: path.join(dir, 'state', 'slang-session.json'),
    learnerSessions, learnerWaiters, learnerCollectors,
    getApi: () => ({
      events: { follow: (sid) => state.followed.push(sid) },
      sessions: {
        create: async (params) => {
          state.created.push(params);
          return { result: { ok: true, value: { sessionId: `slang-${state.created.length}` } } };
        },
      },
      workspace: { archiveSession: async ({ sessionId }) => { state.archived.push(sessionId); } },
    }),
    getSlangLearnerSessionId: () => learnerId,
    setSlangLearnerSessionId: (v) => { learnerId = v; },
    getResolvePresetName: () => (overrides.preset === undefined ? 'qq-chat' : overrides.preset),
    ensureHerWorkspace: async () => 'ws-1',
    ensureChatModel: async (sid) => { state.chatModel.push(sid); },
    unwrap: (r, label) => { if (!r?.result?.ok) throw new Error(`${label} failed`); return r.result.value; },
    readJsonSafe: (file, dflt) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
    },
    atomicWriteJson: (file, value) => { state.wrote.push({ file, value }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); },
    recordSessionKind: (sid, kind) => state.kinds.push({ sid, kind }),
    ...overrides.ctxExtra,
  });
  return { svc, state, learnerSessions, learnerWaiters, learnerCollectors, dir, getId: () => learnerId };
}

test('ensureSlangLearnerSession：没有安全 preset 时 fail-closed（不建也不复用）', async () => {
  const h = makeCtx({ preset: '' });
  await assert.rejects(() => h.svc.ensureSlangLearnerSession(), /拒绝创建或复用会话/);
  assert.equal(h.state.created.length, 0);
  assert.equal(h.state.followed.length, 0);
});

test('ensureSlangLearnerSession：没有记录时新建，用 strict preset + follow + 选模型 + 落盘 + 登记 kind', async () => {
  const h = makeCtx();
  const sid = await h.svc.ensureSlangLearnerSession();
  assert.equal(sid, 'slang-1');
  assert.equal(h.state.created[0].agentPreset, 'qq-chat');
  assert.equal(h.state.created[0].workspaceId, 'ws-1');
  assert.deepEqual(h.state.followed, ['slang-1']);
  assert.deepEqual(h.state.chatModel, ['slang-1']);
  assert.equal(h.state.wrote[0].value.preset, 'qq-chat');
  assert.deepEqual(h.state.kinds, [{ sid: 'slang-1', kind: 'slang' }]);
  assert.ok(h.learnerSessions.has('slang-1'));
  assert.ok(h.state.logs.some((l) => l.includes('黑话学习会话已创建')));
});

test('ensureSlangLearnerSession：内存里已有 id 且磁盘记录一致就复用，不再建也不写盘', async () => {
  const h = makeCtx({ initialId: 'slang-ready' });
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'slang-session.json'), JSON.stringify({ sessionId: 'slang-ready', preset: 'qq-chat', workspaceId: 'ws-1' }));
  assert.equal(await h.svc.ensureSlangLearnerSession(), 'slang-ready');
  assert.equal(h.state.created.length, 0);
  assert.deepEqual(h.state.followed, ['slang-ready']);
  assert.ok(h.learnerSessions.has('slang-ready'));
});

test('ensureSlangLearnerSession：磁盘记录 preset/workspace 一致时恢复它并确认模型', async () => {
  const h = makeCtx();
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'slang-session.json'), JSON.stringify({ sessionId: 'saved-1', preset: 'qq-chat', workspaceId: 'ws-1' }));
  assert.equal(await h.svc.ensureSlangLearnerSession(), 'saved-1');
  assert.equal(h.state.created.length, 0);
  assert.deepEqual(h.state.chatModel, ['saved-1']);
  assert.ok(h.learnerSessions.has('saved-1'));
});

test('ensureSlangLearnerSession：旧记录 preset 不一致 → 失效并重建（旧记录没有权限证明不能复用）', async () => {
  const h = makeCtx({ initialId: null });
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'slang-session.json'), JSON.stringify({ sessionId: 'old-1', preset: 'standard', workspaceId: 'ws-1' }));
  const sid = await h.svc.ensureSlangLearnerSession();
  assert.equal(sid, 'slang-1', '要重建而不是复用 standard preset 的会话');
  await flush();
  assert.deepEqual(h.state.archived, ['old-1'], '旧会话要归档，别在列表里越堆越多');
});

test('ensureSlangLearnerSession：旧记录 workspace 不一致也要重建', async () => {
  const h = makeCtx();
  fs.mkdirSync(path.join(h.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'state', 'slang-session.json'), JSON.stringify({ sessionId: 'old-2', preset: 'qq-chat', workspaceId: 'ws-别的' }));
  assert.equal(await h.svc.ensureSlangLearnerSession(), 'slang-1');
});

test('invalidateSlangLearnerSession：有在途等待者时保留旧会话在集合里（事件还要被消费）', async () => {
  const h = makeCtx({ initialId: 'sid-busy' });
  h.learnerSessions.add('sid-busy');
  h.learnerWaiters.set('sid-busy', [{ resolve: () => {} }]);
  h.svc.invalidateSlangLearnerSession();
  assert.equal(h.getId(), null, 'id 必须清掉');
  assert.equal(h.learnerSessions.has('sid-busy'), true, '在途任务还要靠它收事件');

  const idle = makeCtx({ initialId: 'sid-idle' });
  idle.learnerSessions.add('sid-idle');
  idle.svc.invalidateSlangLearnerSession();
  assert.equal(idle.learnerSessions.has('sid-idle'), false, '没人用就从集合移除');
  await flush();
  assert.deepEqual(idle.state.archived, ['sid-idle']);
});
