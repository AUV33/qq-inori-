// group-facts 金标：群话题的节流/去重、3B→flash 的回退、抽取失败只记日志不外抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupFacts } from '../src/domain/social/group-facts.mjs';

function makeCtx(overrides = {}) {
  const state = { rows: [], appended: [], saves: 0, logs: [], grants: { acquired: 0, released: 0 } };
  const convState = new Map();
  const svc = createGroupFacts({
    cfg: { socialV2: { memory: { dir: '/mem' }, local3b: { enabled: true, groupFacts: true } } },
    getSocialV2State: (key) => {
      if (!convState.has(key)) convState.set(key, {});
      return convState.get(key);
    },
    saveSocialV2State: () => { state.saves += 1; },
    log: (m) => state.logs.push(String(m)),
    MEM_DIR: '/mem',
    filesForScope: () => ({ file: '/mem/group.jsonl', scope: 'group' }),
    loadEntries: () => state.rows,
    appendJsonl: (file, row) => state.appended.push({ file, row }),
    extractTopics: () => ['话题A', '话题B', '话题C'],
    renderGroupTopics: () => '近 24h 群里常聊：话题A、话题B、话题C',
    ensureIsolatedSession: async () => 'session-1',
    acquireTurnSlot: async () => { state.grants.acquired += 1; return { id: 'grant' }; },
    bindTurnGrant: () => {},
    releaseTurnGrant: () => { state.grants.released += 1; },
    groupFactSessions: new Set(),
    groupFactWaiters: new Map(),
    api: { events: { follow: () => {} } },
    submitPromptWithTurnSlot: async () => ({ ok: true }),
    parseFactsJson: (raw, { max }) => (Array.isArray(raw) ? raw : JSON.parse(raw)).slice(0, max ?? 5),
    completeLocal3b: async () => null,
    ...overrides,
  });
  return { svc, state, convState };
}

const digestRows = (n = 4) => Array.from({ length: n }, (_, i) => ({
  kind: 'group-digest',
  time: new Date().toLocaleString('sv-SE'),
  text: `摘要 ${i}`,
}));

test('appendGroupTopicsV2：非群聊 key 直接返回', () => {
  const h = makeCtx();
  h.svc.appendGroupTopicsV2('private:1');
  assert.equal(h.state.appended.length, 0);
});

test('appendGroupTopicsV2：配置关闭 / 摘要不足 4 条 / 未到间隔 都不写', () => {
  const off = makeCtx({ cfg: { socialV2: { memory: { groupTopics: { enabled: false } } } } });
  off.state.rows = digestRows(6);
  off.svc.appendGroupTopicsV2('group:1');
  assert.equal(off.state.appended.length, 0);

  const few = makeCtx();
  few.state.rows = digestRows(3);
  few.svc.appendGroupTopicsV2('group:1');
  assert.equal(few.state.appended.length, 0);

  const gapped = makeCtx();
  gapped.state.rows = digestRows(6);
  gapped.convState.set('group:1', { groupTopicsAt: Date.now() - 1000 });
  gapped.svc.appendGroupTopicsV2('group:1');
  assert.equal(gapped.state.appended.length, 0);
});

test('appendGroupTopicsV2：满足条件写一条 group-fact 并记时间戳', () => {
  const h = makeCtx();
  h.state.rows = digestRows(6);
  h.svc.appendGroupTopicsV2('group:1');
  assert.equal(h.state.appended.length, 1);
  const row = h.state.appended[0].row;
  assert.equal(row.kind, 'group-fact');
  assert.equal(row.theme, '群话题');
  assert.equal(row.scope, 'group');
  assert.equal(row.importance, 3);
  assert.ok(h.convState.get('group:1').groupTopicsAt > 0);
  assert.equal(h.state.saves, 1);
});

test('appendGroupTopicsV2：和上一条完全相同就不重复写（只更新时间）', () => {
  const h = makeCtx();
  const text = '近 24h 群里常聊：话题A、话题B、话题C';
  h.state.rows = [...digestRows(6), { kind: 'group-fact', text }];
  h.svc.appendGroupTopicsV2('group:1');
  assert.equal(h.state.appended.length, 0);
  assert.ok(h.convState.get('group:1').groupTopicsAt > 0);
});

test('askGroupFactsLlm：本地 3B 抽到就不花云端口', async () => {
  let flashCalled = false;
  const h = makeCtx({
    completeLocal3b: async () => '["他买了键盘"]',
    submitPromptWithTurnSlot: async () => { flashCalled = true; return { ok: true }; },
  });
  const facts = await h.svc.askGroupFactsLlm(['摘要'], { max: 5 });
  assert.deepEqual(facts, ['他买了键盘']);
  assert.equal(flashCalled, false);
});

test('askGroupFactsLlm：3B 抽空 / 抛错都回退 flash', async () => {
  const runWithFlash = async (completeLocal3b) => {
    const waiters = new Map();
    const svc = createGroupFacts({
      cfg: { socialV2: { local3b: { enabled: true, groupFacts: true } } },
      getSocialV2State: () => ({}),
      saveSocialV2State: () => {},
      log: () => {},
      MEM_DIR: '/mem',
      filesForScope: () => ({ file: 'f', scope: 'g' }),
      loadEntries: () => [],
      appendJsonl: () => {},
      extractTopics: () => [],
      renderGroupTopics: () => '',
      ensureIsolatedSession: async () => 's1',
      acquireTurnSlot: async () => ({}),
      bindTurnGrant: () => {},
      releaseTurnGrant: () => {},
      groupFactSessions: new Set(),
      groupFactWaiters: waiters,
      api: { events: { follow: () => {} } },
      submitPromptWithTurnSlot: async ({ sessionId }) => {
        const w = (waiters.get(sessionId) ?? [])[0];
        if (w) w.resolve('["群里有人要搬家"]');
        return { result: { ok: true, value: {} } };
      },
      parseFactsJson: (raw) => JSON.parse(raw),
      completeLocal3b,
    });
    return svc.askGroupFactsLlm(['摘要']);
  };
  assert.deepEqual(await runWithFlash(async () => '[]'), ['群里有人要搬家'], '3B 返回空数组也会回退');
  assert.deepEqual(await runWithFlash(async () => { throw new Error('3B 挂了'); }), ['群里有人要搬家'], '3B 抛错也回退');
});

test('askGroupFactsFlash：超时 → 返回空数组、释放 turn 授权、清理等待者', async () => {
  const waiters = new Map();
  const grants = { released: 0 };
  const sessions = new Set();
  const svc = (await import('../src/domain/social/group-facts.mjs')).createGroupFacts({
    cfg: {},
    getSocialV2State: () => ({}),
    saveSocialV2State: () => {},
    log: () => {},
    MEM_DIR: '/mem',
    filesForScope: () => ({ file: 'f', scope: 'g' }),
    loadEntries: () => [],
    appendJsonl: () => {},
    extractTopics: () => [],
    renderGroupTopics: () => '',
    ensureIsolatedSession: async () => 's-timeout',
    acquireTurnSlot: async () => ({}),
    bindTurnGrant: () => {},
    releaseTurnGrant: () => { grants.released += 1; },
    groupFactSessions: sessions,
    groupFactWaiters: waiters,
    api: { events: { follow: () => {} } },
    submitPromptWithTurnSlot: async () => ({ result: { ok: true, value: {} } }),
    parseFactsJson: () => [],
    completeLocal3b: async () => null,
  });
  const facts = await svc.askGroupFactsFlash(['摘要'], { timeoutMs: 5 });
  assert.deepEqual(facts, []);
  assert.equal(grants.released, 1);
  assert.equal(waiters.has('s-timeout'), false, '等待者要清干净，否则 mux 收到事件会炸');
  assert.equal(sessions.has('s-timeout'), false);
});

test('appendGroupFactsLlmNow：先占位再抽（失败也不轰炸），且跳过已有同文', async () => {
  let calls = 0;
  const h = makeCtx({
    completeLocal3b: async () => { calls += 1; return '["事实一","事实二"]'; },
  });
  h.state.rows = [...digestRows(6), { kind: 'group-fact', text: '事实一' }];
  await h.svc.appendGroupFactsLlmNow('group:1');
  const written = h.state.appended.map((a) => a.row.text);
  assert.deepEqual(written, ['事实二'], '已有的「事实一」不重复写');
  assert.ok(h.convState.get('group:1').groupFactsLlmAt > 0, '先占位，失败也不连环重试');
  assert.equal(calls, 1);

  // 间隔内再调：直接返回
  await h.svc.appendGroupFactsLlmNow('group:1');
  assert.equal(h.state.appended.length, 1);
});

test('appendGroupFactsLlm：串行排队，前一个失败不影响后一个', async () => {
  const order = [];
  const h = makeCtx({
    loadEntries: () => { order.push('load'); return digestRows(6); },
    completeLocal3b: async () => { order.push('3b'); return '["x"]'; },
  });
  await Promise.all([h.svc.appendGroupFactsLlm('group:1'), h.svc.appendGroupFactsLlm('group:2')]);
  assert.ok(order.filter((x) => x === '3b').length >= 1);
  assert.ok(h.state.appended.length >= 1);
});
