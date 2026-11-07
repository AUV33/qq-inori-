// reflection-service 的调度金标：关闭、pendingGoals 补做、到期重试、无 owner 跳过。
// 直接调用 _tick（工厂暴露的测试缝），不启动 60s 定时器。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReflectionService } from '../src/domain/memory/reflection-service.mjs';

function ctx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reflect-'));
  const calls = { delivered: [], appended: [] };
  const base = {
    fs,
    path,
    cfg: { ownerQQ: 12345, socialV2: { reflection: {} } },
    STATE_DATA_DIR: dir,
    MEM_DIR: dir,
    log: () => {},
    appendJsonl: (file, row) => { calls.appended.push({ file, row }); },
    writeJsonDocument: (file, obj) => fs.writeFileSync(file, JSON.stringify(obj)),
    readJsonlSafe: () => [],
    deliverToIsolated: async (kind, prompt, opts) => { calls.delivered.push({ kind, prompt, opts }); },
    getSocialV2State: () => ({ recentMessages: [] }),
    buildReflectPrompt: () => 'reflect-prompt',
    checkReflectOutcome: () => ({ ok: true }),
    reflectShouldRun: () => ({ run: false, reason: 'not-window' }),
    summarizeLearning: () => '',
    renderLearningDigest: () => '',
    renderReflectLine: () => '',
    renderSlangJudgeLine: () => '',
    writeReflectInsight: () => {},
    loadGoals: () => [],
    loadLessons: () => [],
    writeDailyDigestV2: () => {},
    writeBehaviorMemorySnapshot: () => {},
    renderBehaviorLedger: () => '',
    stateDataPath: (...parts) => path.join(dir, ...parts),
    state: { sessions: {} },
  };
  Object.assign(base, overrides);
  return { ctx: base, dir, calls };
}

const stateFile = (dir) => path.join(dir, 'reflection.json');
const readState = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));

test('reflection.enabled=false：只跑摘要/行为快照，不反思', async () => {
  const h = ctx({ cfg: { ownerQQ: 12345, socialV2: { reflection: { enabled: false } } } });
  const svc = createReflectionService(h.ctx);
  svc.startNightlyReflection();
  await svc._tick();
  assert.equal(h.calls.delivered.length, 0);
});

test('pendingGoals 到期：单独补目标，不重做整套反思', async () => {
  const h = ctx();
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({ pendingGoals: true, nextRunAt: Date.now() - 1, goalsTries: 1 }));
  const svc = createReflectionService(h.ctx);
  svc.startNightlyReflection();
  await svc._tick();
  assert.equal(h.calls.delivered.length, 1);
  assert.equal(h.calls.delivered[0].opts.reason, 'goals-only');
  assert.match(h.calls.delivered[0].prompt, /goal_list/);
  const st = readState(h.dir);
  assert.equal(st.goalsTries, 2);
  assert.equal(st.nextRunAt, 0);
});

test('nextRunAt 到期：即使不在窗口也重试', async () => {
  const h = ctx();
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({ nextRunAt: Date.now() - 1, retries: 2 }));
  const svc = createReflectionService(h.ctx);
  svc.startNightlyReflection();
  await svc._tick();
  assert.equal(h.calls.delivered.length, 1);
  assert.equal(h.calls.delivered[0].opts.reason, 'reflection-retry');
  assert.equal(h.calls.delivered[0].kind, 'reflect');
});

test('没有 ownerQQ：到期也不投递', async () => {
  const h = ctx({ cfg: { ownerQQ: null, socialV2: { reflection: {} } } });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({ nextRunAt: Date.now() - 1 }));
  const svc = createReflectionService(h.ctx);
  svc.startNightlyReflection();
  await svc._tick();
  assert.equal(h.calls.delivered.length, 0);
});

test('反思素材：生命线摘要进入 prompt（getLifeSummary）', async () => {
  const h = ctx({
    getLifeSummary: () => '收到 3 条消息、睡过 1 次。',
    getLifeState: () => ({ state: 'awake' }),
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  const svc = createReflectionService(h.ctx);
  svc.startNightlyReflection();
  await svc._tick();
  assert.equal(h.calls.delivered.length, 1);
  assert.match(h.calls.delivered[0].prompt, /今天的时间线：收到 3 条消息/);
});

// [REFLECT-LIFE-LOG] R7：反思结果必须回写生命线，否则 Aliveness 成长维恒为 reflections=0、
// 事故回放也看不到「反思整夜空转」。产出检查在 ≥5000ms 定时器里，用 mock.timers 快进。
test('反思达标 → 生命线落 reflection.completed（带产出事实）', async () => {
  const events = [];
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    checkReflectOutcome: () => ({ ok: true, added: 1, reason: 'enough' }),
    appendLifeEvent: (e) => { events.push(e); },
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  h.ctx.cfg.socialV2.reflection.outcomeCheckMs = 6000;
  const svc = createReflectionService(h.ctx);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    svc.startNightlyReflection();
    await svc._tick();
    mock.timers.tick(7000);
  } finally { mock.timers.reset(); }
  const done = events.filter((e) => e.type === 'reflection.completed');
  assert.equal(done.length, 1, '达标反思应回写一条 completed');
  assert.equal(done[0].payload.ok, true);
  assert.equal(done[0].payload.added, 1);
  assert.match(String(done[0].key), /^private:/, '带会话 key，便于回放归因');
});

test('反思未达标 → 落 reflection.failed（可回放），绝不伪装成 completed', async () => {
  const events = [];
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    checkReflectOutcome: () => ({ ok: false, added: 0, reason: 'none' }),
    appendLifeEvent: (e) => { events.push(e); },
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  h.ctx.cfg.socialV2.reflection.outcomeCheckMs = 6000;
  const svc = createReflectionService(h.ctx);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    svc.startNightlyReflection();
    await svc._tick();
    mock.timers.tick(7000);
  } finally { mock.timers.reset(); }
  assert.equal(events.filter((e) => e.type === 'reflection.completed').length, 0, '失败不能虚增成长分');
  const failed = events.filter((e) => e.type === 'reflection.failed');
  assert.equal(failed.length, 1, '失败也要留痕，否则又变成静默');
  assert.equal(failed[0].payload.ok, false);
  assert.equal(failed[0].payload.reason, 'none');
});

// [THOUGHT-ONLY] 实测 11-03 整夜 18 次 reason=none 的根治：她输出了思考文本但没写 lesson_write，
// 旧口径判失败并一路重试到「今夜用尽」。现在应记为 thought-only、收工、原话留存、不虚报 lesson。
test('想了但没写工具 → thought-only：收工不重试、原话留存、生命线标 thoughtOnly', async () => {
  const events = [];
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    deliverToIsolated: async () => ({ ok: true, sessionId: 's-reflect-1' }),
    getLastThoughtTurn: () => ({ kind: 'completed', len: 238, head: '今天他改名的意思我大概懂了', sessionId: 's-reflect-1' }),
    checkReflectOutcome: () => ({
      ok: false, added: 0, reason: 'thought-only', settled: true,
      thought: { kind: 'completed', len: 238, head: '今天他改名的意思我大概懂了', sessionId: 's-reflect-1' },
    }),
    appendLifeEvent: (e) => { events.push(e); },
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  h.ctx.cfg.socialV2.reflection.outcomeCheckMs = 6000;
  const svc = createReflectionService(h.ctx);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    svc.startNightlyReflection();
    await svc._tick();
    mock.timers.tick(7000);
  } finally { mock.timers.reset(); }

  const st = readState(h.dir);
  assert.equal(st.lastResult.reason, 'thought-only');
  assert.equal(st.nextRunAt, 0, 'thought-only 不该排重试');
  assert.equal(st.retries, 0, '不该消耗重试次数');
  const done = events.filter((e) => e.type === 'reflection.completed');
  assert.equal(done.length, 1, '想过了就是真实发生的反思，成长维应看得到');
  assert.equal(done[0].payload.thoughtOnly, true);
  assert.equal(done[0].payload.added, 0, '但绝不冒充写了 lesson');
  const saved = h.calls.appended.filter((a) => String(a.file).includes('reflection-thoughts'));
  assert.equal(saved.length, 1, '她的原话要留成事实账，框架不替她编内容');
  assert.match(saved[0].row.head, /改名的意思/);
});

test('发起失败（DSH 未就绪）也要留痕，不再静默', async () => {
  const events = [];
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    deliverToIsolated: async () => { throw new Error('DSH 未就绪'); },
    appendLifeEvent: (e) => { events.push(e); },
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  const svc = createReflectionService(h.ctx);
  await svc._tick();
  const sf = h.calls.appended.filter((a) => a.row?.kind === 'send-failed');
  assert.equal(sf.length, 1, '账本要记下"没投出去"');
  assert.match(sf[0].row.error, /DSH 未就绪/);
  const failed = events.filter((e) => e.type === 'reflection.failed');
  assert.equal(failed.length, 1, '生命线也要能看到发起失败');
  assert.equal(failed[0].payload.reason, 'send-failed');
});

test('本轮 sessionId 会被带到产出检查，防止旧回合串台', async () => {
  const seen = [];
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    deliverToIsolated: async () => ({ ok: true, sessionId: 's-reflect-42' }),
    checkReflectOutcome: (_b, _a, opts) => { seen.push(opts); return { ok: true, added: 1, reason: 'enough' }; },
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  h.ctx.cfg.socialV2.reflection.outcomeCheckMs = 6000;
  const svc = createReflectionService(h.ctx);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    svc.startNightlyReflection();
    await svc._tick();
    mock.timers.tick(7000);
  } finally { mock.timers.reset(); }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's-reflect-42');
  assert.ok('thought' in seen[0], '思考输出要一并交给判据');
});

test('未注入 appendLifeEvent 时行为不变（向后兼容，no-op 不抛）', async () => {
  const h = ctx({
    reflectShouldRun: () => ({ run: true, reason: 'window' }),
    checkReflectOutcome: () => ({ ok: false, added: 0, reason: 'none' }),
  });
  fs.writeFileSync(stateFile(h.dir), JSON.stringify({}));
  h.ctx.cfg.socialV2.reflection.outcomeCheckMs = 6000;
  const svc = createReflectionService(h.ctx);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    svc.startNightlyReflection();
    await svc._tick();
    assert.doesNotThrow(() => mock.timers.tick(7000));
  } finally { mock.timers.reset(); }
  assert.equal(h.calls.delivered.length, 1);
});
