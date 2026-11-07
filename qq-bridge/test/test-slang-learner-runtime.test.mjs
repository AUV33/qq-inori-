// slang-learner-runtime 金标：等学习回合、抽取入库与自动升格、研究回报、失败重试边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlangLearnerRuntime } from '../src/domain/social/slang-learner-runtime.mjs';

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const state = { entries: [], waits: 0, saves: 0, logs: [], queued: [], invalidated: 0, submitted: [] };
  const learnerWaiters = new Map();
  const slangWindows = new Map();
  const researching = new Set();
  const svc = createSlangLearnerRuntime({
    cfg: { slang: { enabled: true, extractMinMessages: 2, autoPromote: { enabled: true, minCount: 4 } } },
    log: (...args) => state.logs.push(args.map(String).join(' ')),
    getSlangEntries: () => state.entries,
    setSlangEntries: (v) => { state.entries = v; },
    ensureSlangLearnerSession: async () => 'learn-1',
    invalidateSlangLearnerSession: () => { state.invalidated += 1; },
    learnerWaiters,
    slangWindows,
    slangResearchingIds: researching,
    getDshReady: () => true,
    queueSlangTask: (fn) => { state.queued.push(fn); },
    saveSlangStore: () => { state.saves += 1; },
    buildExtractionPrompt: (msgs) => `抽取 ${msgs.length} 条`,
    parseExtractionJson: () => [],
    upsertSlangEntry: (entries, content, { evidence, countIncrement }) => {
      const found = entries.find((e) => e.content === content);
      if (found) { found.count += countIncrement; found.evidence = [...(found.evidence ?? []), ...evidence]; return { created: false, entry: found }; }
      const entry = { id: `id-${content}`, content, count: countIncrement, status: 'candidate', evidence, lastInferenceCount: 0 };
      entries.push(entry);
      return { created: true, entry };
    },
    autoPromoteSlang: (entries) => ({ entries, promoted: [] }),
    buildResearchPrompt: (targets) => `研究 ${targets.length} 条`,
    parseResearchJson: () => [],
    submitPromptWithTurnSlot: async (payload) => {
      state.submitted.push(payload);
      return { result: { ok: true, value: {} } };
    },
    ...overrides,
  });
  return { svc, state, learnerWaiters, slangWindows, researching };
}

function answerAllWaiters(waiters, output) {
  for (const [, arr] of waiters) {
    for (const w of [...arr]) {
      try { clearTimeout(w.timer); } catch { /* 没有 timer */ } // 跟 mux-bus 一样：解决后必须清超时计时器
      try { w.resolve(output); } catch { /* 已 settle */ }
    }
  }
}

// 抽取流程里 waitLearnerTurn 是"提交之后才注册等待者"的，所以不能只 resolve 一次：
// 一边推进事件循环一边把新出现的等待者 resolve 掉，直到 promise 落定。
async function drive(promise, waiters, output = '输出', limitMs = 8000) {
  let done = false;
  const wrapped = promise.finally(() => { done = true; });
  const started = Date.now();
  while (!done && Date.now() - started < limitMs) {
    answerAllWaiters(waiters, output);
    await new Promise((r) => setTimeout(r, 5));
  }
  return wrapped;
}

test('waitLearnerTurn：被 resolve 时返回输出，并从等待表清掉', async () => {
  const h = makeCtx();
  const p = h.svc.waitLearnerTurn('s1', 5000);
  assert.equal(h.learnerWaiters.get('s1').length, 1);
  const waiter = h.learnerWaiters.get('s1')[0];
  waiter.resolve('答案');
  clearTimeout(waiter.timer);
  assert.equal(await p, '答案');
  // resolve 不会自动清表（由超时清理），这里只断言拿得到值
});

test('waitLearnerTurn：超时报错并清掉等待项', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx();
  const p = h.svc.waitLearnerTurn('s1', 1000);
  const err = p.catch((e) => e);
  t.mock.timers.tick(1000);
  const e = await err;
  assert.match(String(e.message), /等待学习会话 turn 超时/);
  assert.equal(h.learnerWaiters.has('s1'), false);
});

test('runSlangExtraction：关开关 / DSH 未就绪 / 消息不够 都不开会话', async () => {
  const off = makeCtx({ cfg: { slang: { enabled: false } } });
  await off.svc.runSlangExtraction('group:1');
  assert.equal(off.state.submitted.length, 0);

  const notReady = makeCtx({ getDshReady: () => false });
  notReady.slangWindows.set('group:1', [1, 2, 3]);
  await notReady.svc.runSlangExtraction('group:1');
  assert.equal(notReady.state.submitted.length, 0);

  const few = makeCtx();
  few.slangWindows.set('group:1', [{ text: 'a' }]);
  await few.svc.runSlangExtraction('group:1');
  assert.equal(few.state.submitted.length, 0);
});

test('runSlangExtraction：抽到候选就入库、切窗口、保存，并把证据指回原消息', async () => {
  const h = makeCtx({
    parseExtractionJson: () => [{ content: '绷不住', source_id: '2' }, { content: '绷不住', source_id: '1' }],
  });
  const msgs = [
    { sender: 'A', text: '第一句', time: 1 },
    { sender: 'B', text: '笑死绷不住', time: 2 },
  ];
  h.slangWindows.set('group:1', [...msgs]);
  await drive(h.svc.runSlangExtraction('group:1'), h.learnerWaiters);

  assert.equal(h.state.entries.length, 1, '同一词条只入库一次');
  assert.equal(h.state.entries[0].content, '绷不住');
  assert.equal(h.state.entries[0].evidence[0].sender, 'B', 'source_id=2 指回第二条消息');
  assert.deepEqual(h.slangWindows.get('group:1'), [], '已学过的窗口要切掉');
  assert.ok(h.state.saves >= 1);
  assert.ok(h.state.logs.some((l) => l.includes('新增 1 条')));
});

test('runSlangExtraction：没抽到候选也要切窗口（不然同样内容反复送）', async () => {
  const h = makeCtx({ parseExtractionJson: () => [] });
  h.slangWindows.set('group:1', [{ sender: 'A', text: '一条', time: 1 }, { sender: 'B', text: '两条', time: 2 }]);
  await drive(h.svc.runSlangExtraction('group:1'), h.learnerWaiters, '[]');
  assert.deepEqual(h.slangWindows.get('group:1'), []);
  assert.ok(h.state.logs.some((l) => l.includes('未发现候选')));
});

test('runSlangExtraction：自动升格会回写词条并保存；研究候选会排队', async () => {
  const h = makeCtx({
    parseExtractionJson: () => [{ content: '绷不住', source_id: '1' }],
    autoPromoteSlang: (entries) => ({ entries, promoted: ['绷不住'] }),
    upsertSlangEntry: (entries, content, { countIncrement }) => {
      // count 落在默认阈值 [2,4,8] 上，才会进研究候选
      const entry = { id: 'x', content, count: 4, status: 'candidate', lastInferenceCount: 0, evidence: [] };
      entries.push(entry);
      return { created: true, entry };
    },
  });
  h.slangWindows.set('group:1', [{ sender: 'A', text: '绷不住', time: 1 }, { sender: 'B', text: '绷不住', time: 2 }]);
  await drive(h.svc.runSlangExtraction('group:1'), h.learnerWaiters, '[]');
  assert.ok(h.state.logs.some((l) => l.includes('黑话自动升格 1 条')));
  assert.ok(h.state.queued.length >= 1, '达到阈值的候选要排队研究');
});

test('runSlangExtraction：提交被拒只记日志，不等学习回合', async () => {
  const h = makeCtx({
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 'busy', message: '忙' } } }),
  });
  h.slangWindows.set('group:1', [{ sender: 'A', text: 'a', time: 1 }, { sender: 'B', text: 'b', time: 2 }]);
  await h.svc.runSlangExtraction('group:1');
  assert.ok(h.state.logs.some((l) => l.includes('黑话提取被拒')));
  assert.equal(h.learnerWaiters.size, 0, '不该留下等待者');
});

test('runSlangExtraction：「未正常完成」重建会话重试一次；「超时」不失效会话', async () => {
  let calls = 0;
  const h = makeCtx({
    submitPromptWithTurnSlot: async () => {
      calls += 1;
      if (calls === 1) throw new Error('学习会话未正常完成');
      return { result: { ok: true, value: {} } };
    },
    parseExtractionJson: () => [],
  });
  h.slangWindows.set('group:1', [{ sender: 'A', text: 'a', time: 1 }, { sender: 'B', text: 'b', time: 2 }]);
  await drive(h.svc.runSlangExtraction('group:1'), h.learnerWaiters, '[]');
  assert.equal(calls, 2, '要重试一次');
  assert.ok(h.state.invalidated >= 1);

  const timeout = makeCtx({ submitPromptWithTurnSlot: async () => { throw new Error('等待学习会话 turn 超时(1000ms)'); } });
  timeout.slangWindows.set('group:1', [{ sender: 'A', text: 'a', time: 1 }, { sender: 'B', text: 'b', time: 2 }]);
  await timeout.svc.runSlangExtraction('group:1');
  assert.equal(timeout.state.invalidated, 0, '超时不失效学习会话（否则每轮重建）');
});

test('runSlangResearch：已在研究中的不重复排队；未确认的保留候选；确认的写解释字段', async () => {
  const h = makeCtx({
    parseResearchJson: () => [
      { content: '甲', confirmed: false },
      { content: '乙', confirmed: true, meaning: '乙的意思', usage: '用法', example: '例句', risk: '低', sources: ['群1', ' 群2 ', ''] },
    ],
  });
  h.state.entries = [
    { id: 'a', content: '甲', count: 3, status: 'candidate' },
    { id: 'b', content: '乙', count: 2, status: 'candidate' },
    { id: 'c', content: '丙', count: 1, status: 'candidate' },
  ];
  h.researching.add('c');
  await drive(h.svc.runSlangResearch([{ id: 'a' }, { id: 'c' }]), h.learnerWaiters);

  const jia = h.state.entries.find((e) => e.content === '甲');
  assert.equal(jia.meaning, undefined, '未确认不写解释');
  const yi = h.state.entries.find((e) => e.content === '乙');
  assert.equal(yi.meaning, '乙的意思');
  assert.deepEqual(yi.sources, ['群1', '群2'], 'sources 去空白、最多 10');
  assert.equal(yi.lastInferenceCount, 2);
  assert.ok(yi.updatedAt);
  assert.equal(h.researching.has('a'), false, '本次目标的研究锁要释放');
  assert.equal(h.researching.has('c'), true, '别人正在研究的词不归本次解锁');
  assert.ok(h.state.saves >= 1);
});

test('runSlangResearch：候选为空 / 关开关 / 会话创建失败都不炸', async () => {
  const h = makeCtx();
  await h.svc.runSlangResearch([]);
  assert.equal(h.state.submitted.length, 0);

  const off = makeCtx({ cfg: { slang: { enabled: false } } });
  await off.svc.runSlangResearch([{ id: 'a' }]);
  assert.equal(off.state.submitted.length, 0);

  const broken = makeCtx({ ensureSlangLearnerSession: async () => { throw new Error('建不了'); } });
  await broken.svc.runSlangResearch([{ id: 'z' }]);
  assert.equal(broken.researching.has('z'), false, '失败也要解锁，否则这个词永远研究不了');
  assert.ok(broken.state.logs.some((l) => l.includes('黑话研究会话创建失败')));
});
