// 金标单测：src/runtime-tasks.mjs 的 createTaskService(ctx)
//
// 纪律：
//   · 依赖模块（taskledger/taskpool/works/skills/traces）会在 import 期解析默认文件路径，
//     所以先把 QQ_INORI_ROOT 指到临时根目录、MZ_TASK_LEDGER 指到临时台账，再动态 import，
//     保证不读写仓库 data/、state/。
//   · 桩 ctx + 内存状态测状态机：池恢复、排队/派发、失败回退、看门狗超时、迁移、工作台。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-runtime-tasks-'));
const LEDGER = path.join(ROOT, 'task-ledger.jsonl');
process.env.QQ_INORI_ROOT = ROOT;
process.env.MZ_TASK_LEDGER = LEDGER;

const { createTaskService } = await import('../src/domain/conversation/runtime-tasks.mjs');

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // 恢复环境：即使同进程跑别的测试文件，也不会继续指向临时根目录。
  delete process.env.QQ_INORI_ROOT;
  delete process.env.MZ_TASK_LEDGER;
});

const DEFAULT_CAP = 30 * 60 * 1000;

let caseSeq = 0;
function makeCase(overrides = {}) {
  caseSeq += 1;
  const base = path.join(ROOT, `case-${caseSeq}`);
  const STATE_DIR = path.join(base, 'state');
  const STATE_DATA_DIR = path.join(STATE_DIR, 'data');
  fs.mkdirSync(STATE_DATA_DIR, { recursive: true });

  const calls = [];
  const logs = [];
  const push = (name, args) => { calls.push({ name, args }); };
  const socialStates = new Map();
  let created = 0;

  const dep = {
    api: {
      sessions: {
        create: async (payload) => {
          push('api.sessions.create', [payload]);
          created += 1;
          return { sessionId: `sess-${created}` };
        },
        list: async () => { push('api.sessions.list', []); return []; },
      },
      callUnary: async (...args) => { push('api.callUnary', args); return { result: { ok: true } }; },
      events: {
        follow: (...args) => push('api.events.follow', args),
        forget: (...args) => push('api.events.forget', args),
      },
      stopSessionWork: async (...args) => { push('api.stopSessionWork', args); },
    },
    cfgRef: {
      ownerQQ: '1001',
      socialV2: {
        taskPool: { maxParallel: 2 },
        agentPreset: 'qq-chat-v2',
        skills: { enabled: true, file: path.join(base, 'skills.json') },
        works: { maxParallel: 2 },
      },
    },
    log: (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); },
    isDshReady: () => true,
    STATE_DIR,
    STATE_DATA_DIR,
    worksStore: [],
    ensureHerWorkspace: async () => { push('ensureHerWorkspace', []); return 'ws-her'; },
    ensureChatModel: async (...args) => { push('ensureChatModel', args); },
    recordSessionKind: (...args) => { push('recordSessionKind', args); },
    getSocialV2State: (key) => {
      const k = String(key);
      if (!socialStates.has(k)) socialStates.set(k, { lastTaskDone: null, agentToken: '', ownerAgentToken: '' });
      return socialStates.get(k);
    },
    saveSocialV2State: () => { push('saveSocialV2State', []); },
    scheduleWakeV2: (...args) => { push('scheduleWakeV2', args); },
    recentTaskReportAt: new Map(),
    taskSessions: new Set(),
    taskCollectors: new Map(),
    unwrap: (value) => value,
    buildWakePromptV2: (...args) => { push('buildWakePromptV2', args); return 'WAKE-CONTEXT'; },
    rememberAgentToken: (...args) => { push('rememberAgentToken', args); },
    submitPromptWithTurnSlot: async (payload) => {
      push('submitPromptWithTurnSlot', [payload]);
      return { result: { ok: true } };
    },
    ...overrides,
  };

  const c = {
    base,
    dep,
    calls,
    logs,
    socialStates,
    called(name) { return calls.filter((x) => x.name === name).map((x) => x.args); },
    count(name) { return this.called(name).length; },
    logText() { return logs.join('\n'); },
  };
  Object.assign(c, { STATE_DIR, STATE_DATA_DIR });
  return c;
}

function poolFile(c) { return path.join(c.STATE_DIR, 'task-pool.json'); }
function worksFile(c) { return path.join(c.STATE_DATA_DIR, 'works.json'); }

function writePool(c, running) {
  fs.mkdirSync(c.STATE_DIR, { recursive: true });
  fs.writeFileSync(poolFile(c), JSON.stringify({ running }, null, 1), 'utf8');
}

function readPool(c) {
  return JSON.parse(fs.readFileSync(poolFile(c), 'utf8')).running;
}

function writeLedger(rows) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function readLedger() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function runningRow(id, sessionId, extra = {}) {
  return {
    id,
    at: '2026-11-01T00:00:00.000Z',
    task: extra.task || `任务 ${id}`,
    taskFull: extra.taskFull || extra.task || `任务 ${id}`,
    reportTo: extra.reportTo ?? '',
    sessionId,
    status: 'running',
    ownerRequested: false,
    acceptance: '',
    fingerprint: '',
    outcome: 'unknown',
    evidence: '',
    evidenceQuality: 'none',
    attempts: 0,
    lastError: '',
    nextAction: '',
    intentionId: '',
    lastAttemptAt: '',
    ...extra,
  };
}

function queuedRow(id, extra = {}) {
  return runningRow(id, '', { task: `排队 ${id}`, ...extra, status: 'queued' });
}

// ── 初始化 / 路径 ───────────────────────────────────────────────────────────

test('createTaskService: 从 state/task-pool.json 恢复 running，并过滤坏条目', () => {
  const c = makeCase();
  writePool(c, [
    { taskId: 't1', sessionId: 's1', dispatchAt: 1, taskShort: '在跑', reportTo: 'private:1' },
    { taskId: 't2', sessionId: '' },
    { taskId: 't3', sessionId: 42 },
    { bad: true },
  ]);
  const svc = createTaskService(c.dep);
  assert.ok(Array.isArray(svc.running));
  assert.deepEqual(svc.running, [{ taskId: 't1', sessionId: 's1', dispatchAt: 1, taskShort: '在跑', reportTo: 'private:1' }]);
  for (const key of [
    'startWork', 'reconcileWorksOnBoot', 'drainTaskPool', 'pickNextTaskRow', 'taskPoolWatchdog',
    'migrateTaskPoolOnce', 'notifyTaskDone', 'taskBoardSnapshot', 'retireTaskSession',
    'dispatchQueuedTask', 'deliverTaskPrompt', 'buildTaskPromptText', 'buildWorkPromptText',
    'workByTaskId', 'updateWorkById', 'worksSave', 'poolSave', 'createTaskSession', 'takeTaskSkillIds',
  ]) {
    assert.equal(typeof svc[key], 'function', `缺少导出 ${key}`);
  }
});

test('createTaskService: 没有 pool 文件时 running 为空数组', () => {
  const c = makeCase();
  const svc = createTaskService(c.dep);
  assert.deepEqual(svc.running, []);
});

// ── 提示词构造（纯函数） ─────────────────────────────────────────────────────

test('buildWorkPromptText: 带目标/验收与收尾格式；缺字段不留空行', () => {
  const svc = createTaskService(makeCase().dep);
  const text = svc.buildWorkPromptText({
    id: 'w-1', title: '修好登录', goal: '能登进去', acceptance: '手动登录成功',
  });
  assert.match(text, /^【分身工作 · 你是当前 AI 伙伴的分身】/);
  assert.match(text, /要做的事：修好登录/);
  assert.match(text, /目标：能登进去/);
  assert.match(text, /验收：手动登录成功/);
  assert.match(text, /work_update\(work_id, "done"/);
  assert.match(text, /【任务结果】成功\/失败\/卡住｜证据：/);
  assert.match(text, /work id=w-1/);
  assert.ok(!text.includes('\n\n\n'), '空字段不应留下连续空行');

  const minimal = svc.buildWorkPromptText({ id: 'w-2' });
  assert.match(minimal, /要做的事：w-2/);
  assert.ok(!minimal.includes('目标：'));
  assert.ok(!minimal.includes('验收：'));
});

test('buildTaskPromptText: 包含回报地址与收尾格式；无技能命中时不加技能段', () => {
  const c = makeCase();
  const svc = createTaskService(c.dep);
  const text = svc.buildTaskPromptText('把报告发给我', 'private:1');
  assert.match(text, /^【接手一件事 · 没人等你回话】/);
  assert.match(text, /要做的事：把报告发给我/);
  assert.match(text, /做完把结果发到 private:1/);
  assert.match(text, /用 qq_send_message，key 参数填 private:1/);
  assert.match(text, /【任务结果】成功\/失败\/卡住｜证据：/);
  assert.ok(!text.includes('【你学过这些做法'));
});

test('buildTaskPromptText: 命中技能时注入步骤/判据/掌握度，回调返回技能 id 并记 injected', () => {
  const c = makeCase();
  const file = c.dep.cfgRef.socialV2.skills.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [{
      id: 's1', name: '截图取证', desc: '截图并保存文件',
      steps: ['打开', '截图', '保存'], verify: '文件存在', mastery: 0.7,
    }],
  }), 'utf8');
  const svc = createTaskService(c.dep);
  const ids = [];
  const text = svc.buildTaskPromptText('帮我做截图取证并保存文件', 'private:1', (got) => ids.push(got));
  assert.deepEqual(ids, [['s1']]);
  assert.match(text, /【你学过这些做法（能对上就照做，也可以改）】/);
  assert.match(text, /- 截图取证：截图并保存文件｜步骤：打开 → 截图 → 保存｜成功判据：文件存在｜掌握 0.7/);
  assert.match(text, /用到的每条做完后调 skill_record/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.items[0].injected, 1, 'noteInjected 应写回技能文件');
});

test('buildTaskPromptText: skills.enabled=false 时不读技能库', () => {
  const c = makeCase();
  c.dep.cfgRef.socialV2.skills.enabled = false;
  const svc = createTaskService(c.dep);
  let called = false;
  const text = svc.buildTaskPromptText('截图取证', 'private:1', () => { called = true; });
  assert.equal(called, false);
  assert.ok(!text.includes('【你学过这些做法'));
});

// ── startWork / 工作台 ──────────────────────────────────────────────────────

test('startWork: 池满时只登记排队（ledger + works.json），不建会话', async () => {
  const c = makeCase();
  writeLedger([]);
  writePool(c, [
    { taskId: 't-a', sessionId: 's-a', dispatchAt: 1, taskShort: '在跑 A', reportTo: '' },
    { taskId: 't-b', sessionId: 's-b', dispatchAt: 1, taskShort: '在跑 B', reportTo: '' },
  ]);
  const svc = createTaskService(c.dep);
  const work = await svc.startWork({
    title: '修好登录', goal: '能登录', acceptance: '手动登录成功', reportTo: 'private:1001',
  });

  assert.match(work.id, /^w/);
  assert.match(work.taskId, /^t/);
  assert.equal(work.status, 'queued');
  assert.equal(c.dep.worksStore.length, 1);
  assert.equal(c.dep.worksStore[0].id, work.id);

  const works = JSON.parse(fs.readFileSync(worksFile(c), 'utf8'));
  assert.equal(works.works[0].taskId, work.taskId);

  const rows = readLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, work.taskId);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].reportTo, 'private:1001');
  assert.equal(rows[0].fingerprint, 'work:修好登录');
  assert.match(rows[0].task, /^【分身工作/);
  assert.match(rows[0].taskFull, /验收：手动登录成功/);
  assert.equal(c.count('api.sessions.create'), 0, '池满不应建会话');
  assert.match(c.logText(), /\[works\] 新活 .*「修好登录」→ 任务/);
});

test('startWork: 空标题抛错且不落盘、不入台账', async () => {
  const c = makeCase();
  writeLedger([]);
  const svc = createTaskService(c.dep);
  await assert.rejects(() => svc.startWork({ title: '   ' }), /title 不能为空/);
  assert.equal(c.dep.worksStore.length, 0);
  assert.deepEqual(readLedger(), []);
  assert.equal(fs.existsSync(worksFile(c)), false);
});

test('startWork: 池有空位 → 建任务会话、投递提示、promote 台账、写入 pool（非 owner 发起 → agent preset）', async () => {
  const c = makeCase();
  c.dep.cfgRef.socialV2.taskPool.maxParallel = 1;
  writeLedger([]);
  writePool(c, []);
  const svc = createTaskService(c.dep);
  const work = await svc.startWork({
    title: '派一件活', acceptance: '文件：out.txt', reportTo: 'private:1001',
  });

  assert.equal(svc.running.length, 1);
  const entry = svc.running[0];
  assert.equal(entry.taskId, work.taskId);
  assert.equal(entry.sessionId, 'sess-1');
  assert.match(entry.taskShort, /^【分身工作/);
  assert.equal(entry.reportTo, 'private:1001');
  assert.equal(readPool(c).length, 1);

  // [PRESET-BY-CALLER] startWork 是她自己的活（不是主人私聊发起），即便 reportTo 是主人
  // 也只能拿 agent preset：admin preset 只由 ownerRequested=true（主人 lane 的 handoff）触发。
  const createArgs = c.called('api.sessions.create')[0][0];
  assert.deepEqual(createArgs, { workspaceId: 'ws-her', agentPreset: 'qq-chat-v2' });
  assert.deepEqual(c.called('ensureChatModel')[0], ['sess-1', 'low']);
  assert.deepEqual(c.called('api.callUnary')[0][0], 'session/rename');
  assert.deepEqual(c.called('recordSessionKind')[0], ['sess-1', 'task']);

  // 台账 promote
  const rows = readLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'running');
  assert.equal(rows[0].sessionId, 'sess-1');

  // 投递内容
  const payload = c.called('submitPromptWithTurnSlot')[0][0];
  assert.equal(payload.sessionId, 'sess-1');
  assert.equal(payload.kind, 'background');
  assert.equal(payload.label, 'task:sess-1');
  const text = payload.content[0].text;
  assert.match(text, /^WAKE-CONTEXT\n\n【接手一件事/);
  assert.match(text, /派一件活/);
  assert.match(text, /【验收】文件：out\.txt/);
  assert.match(text, /做完必须给证据/);
  assert.deepEqual(c.called('api.events.follow')[0], ['sess-1']);
  assert.equal(c.dep.taskSessions.has('sess-1'), true);
  assert.match(c.logText(), /\[task-pool\] 任务会话 preset=qq-chat-v2（来源 private:1001）/);
  assert.match(c.logText(), /\[task-pool\] 已投递任务会话 sess-1/);
  assert.match(c.logText(), /\[task-pool\] 开跑/);
});

test('startWork: 非 owner 来源使用 agentPreset；cfg 可覆盖两个 preset', async () => {
  // 默认 agentPreset
  {
    const c = makeCase();
    c.dep.cfgRef.socialV2.taskPool.maxParallel = 1;
    writeLedger([]);
    writePool(c, []);
    const svc = createTaskService(c.dep);
    await svc.startWork({ title: '群活', reportTo: 'group:42' });
    assert.equal(c.called('api.sessions.create')[0][0].agentPreset, 'qq-chat-v2');
    assert.match(c.logText(), /来源 group:42/);
  }
  // 自定义两个 preset
  {
    const c = makeCase();
    c.dep.cfgRef.socialV2.taskPool.maxParallel = 1;
    c.dep.cfgRef.socialV2.taskPool.preset = 'custom-admin';
    c.dep.cfgRef.socialV2.agentPreset = 'custom-agent';
    writeLedger([]);
    writePool(c, []);
    const svc = createTaskService(c.dep);
    await svc.startWork({ title: '自定义', reportTo: 'private:1001' });
    assert.equal(c.called('api.sessions.create')[0][0].agentPreset, 'custom-agent');
  }
});

// ── 派发失败回退 ────────────────────────────────────────────────────────────

test('drainTaskPool: prompt 被拒 → 会话归档、台账退回 queued、状态清干净', async () => {
  const c = makeCase();
  c.dep.submitPromptWithTurnSlot = async (payload) => {
    c.calls.push({ name: 'submitPromptWithTurnSlot', args: [payload] });
    return { result: { ok: false, error: { code: 'busy', message: 'no slot' } } };
  };
  writeLedger([queuedRow('t-reject', { task: '会失败的活', reportTo: 'private:1' })]);
  writePool(c, []);
  const svc = createTaskService(c.dep);
  await svc.drainTaskPool();

  assert.equal(svc.running.length, 0);
  assert.equal(readPool(c).length, 0);
  const rows = readLedger();
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].sessionId, '');
  assert.deepEqual(c.called('api.stopSessionWork')[0], ['sess-1']);
  assert.equal(c.called('api.callUnary').some(([method]) => method === 'workspace/archiveSession'), true);
  assert.equal(c.dep.taskSessions.has('sess-1'), false);
  assert.match(c.logText(), /投递失败，t-reject 退回排队: task prompt 被拒: busy: no slot/);
});

test('drainTaskPool: 建会话失败 → 保持排队、不 promote、不占池', async () => {
  const c = makeCase();
  c.dep.api.sessions.create = async () => { throw new Error('create failed'); };
  writeLedger([queuedRow('t-create', { task: '建不出会话' })]);
  writePool(c, []);
  const svc = createTaskService(c.dep);
  await svc.drainTaskPool();

  assert.equal(svc.running.length, 0);
  const rows = readLedger();
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].sessionId, '');
  assert.equal(c.count('submitPromptWithTurnSlot'), 0);
  assert.match(c.logText(), /建会话失败，t-create 继续排队: create failed/);
});

test('dispatchQueuedTask: promote 失败（台账已被外部终态）→ 归档会话并视为已处理', async () => {
  const c = makeCase();
  // 台账里同 id 行已是终态 → promoteTask 返回 null
  writeLedger([runningRow('t-done', 's-x', { status: 'finished', outcome: 'success' })]);
  writePool(c, []);
  const svc = createTaskService(c.dep);
  const ok = await svc.dispatchQueuedTask({ id: 't-done', task: '重复派发', reportTo: '', acceptance: '' });

  assert.equal(ok, true);
  assert.equal(svc.running.length, 0);
  assert.deepEqual(c.called('api.stopSessionWork')[0], ['sess-1']);
  assert.equal(c.called('api.callUnary').some(([method]) => method === 'workspace/archiveSession'), true);
  assert.equal(c.count('submitPromptWithTurnSlot'), 0);
});

// ── 挑任务 / 池上限 ─────────────────────────────────────────────────────────

test('pickNextTaskRow: owner 任务优先；工作台任务受 works.maxParallel 限制', () => {
  // owner 行优先于工作台行（即使工作台行先入队）
  {
    const c = makeCase();
    writeLedger([
      queuedRow('t-work', { task: '【分身工作 · x】做活', at: '2026-11-01T00:00:00.000Z' }),
      queuedRow('t-owner', { task: '普通任务', at: '2026-11-01T00:00:01.000Z' }),
    ]);
    writePool(c, []);
    const svc = createTaskService(c.dep);
    assert.equal(svc.pickNextTaskRow().id, 't-owner');
  }
  // 只有工作台任务且并行额度未满 → 取第一条
  {
    const c = makeCase();
    writeLedger([queuedRow('t-w', { task: '【分身工作 · y】做活' })]);
    writePool(c, []);
    const svc = createTaskService(c.dep);
    assert.equal(svc.pickNextTaskRow().id, 't-w');
  }
  // 工作台并行额度已满 → 不再派工作台任务
  {
    const c = makeCase();
    c.dep.cfgRef.socialV2.works.maxParallel = 1;
    writeLedger([queuedRow('t-w2', { task: '【分身工作 · z】做活' })]);
    writePool(c, [{ taskId: 't-runw', sessionId: 's-w', dispatchAt: 1, taskShort: '【分身工作 · 在跑', reportTo: '' }]);
    const svc = createTaskService(c.dep);
    assert.equal(svc.pickNextTaskRow(), null);
  }
  // 空队列
  {
    const c = makeCase();
    writeLedger([]);
    const svc = createTaskService(c.dep);
    assert.equal(svc.pickNextTaskRow(), null);
  }
});

test('taskBoardSnapshot: capacity / running / queued / resumable 形状', () => {
  const c = makeCase();
  c.dep.cfgRef.socialV2.taskPool.maxParallel = 3;
  writePool(c, [{ taskId: 't-run', sessionId: 's-run', dispatchAt: 123, taskShort: '在跑的活', reportTo: 'private:1' }]);
  writeLedger([
    queuedRow('t-q', { at: '2026-11-01T00:00:00.000Z', task: '排队的活', reportTo: 'private:2' }),
    runningRow('t-f', 's-f', {
      status: 'failed', outcome: 'blocked', task: '卡住的活',
      nextAction: '补一张截图', finishedAt: new Date().toISOString(),
    }),
  ]);
  const svc = createTaskService(c.dep);
  const snap = svc.taskBoardSnapshot();
  assert.equal(snap.capacity, 3);
  assert.deepEqual(snap.running, [{ taskId: 't-run', sessionId: 's-run', dispatchAt: 123, task: '在跑的活', reportTo: 'private:1' }]);
  assert.deepEqual(snap.queued, [{ id: 't-q', at: '2026-11-01T00:00:00.000Z', task: '排队的活', reportTo: 'private:2' }]);
  assert.equal(snap.resumable.length, 1);
  assert.equal(snap.resumable[0].id, 't-f');
  assert.equal(snap.resumable[0].outcome, 'blocked');
  assert.equal(snap.resumable[0].nextAction, '补一张截图');
});

// ── 工作记录 ────────────────────────────────────────────────────────────────

test('workByTaskId / updateWorkById: 命中更新并落盘，未命中/不可变回 null', () => {
  const c = makeCase();
  c.dep.worksStore = [
    { id: 'w1', taskId: 't1', status: 'running', progress: [] },
    { id: 'w2', taskId: 't2', status: 'running', progress: [] },
  ];
  const svc = createTaskService(c.dep);
  assert.equal(svc.workByTaskId('t1').id, 'w1');
  assert.equal(svc.workByTaskId('nope'), null);
  assert.equal(svc.workByTaskId(''), null);

  const next = svc.updateWorkById('w1', (w) => ({ ...w, status: 'done', touched: true }));
  assert.equal(next.status, 'done');
  assert.equal(c.dep.worksStore[0].status, 'done');
  const saved = JSON.parse(fs.readFileSync(worksFile(c), 'utf8')).works;
  assert.equal(saved[0].status, 'done');

  assert.equal(svc.updateWorkById('missing', (w) => w), null);
  assert.equal(svc.updateWorkById('w2', () => null), null);
  assert.equal(c.dep.worksStore[1].status, 'running');
});

test('worksSave: 把当前 worksStore 原子写入 STATE_DATA_DIR/works.json', () => {
  const c = makeCase();
  const svc = createTaskService(c.dep);
  c.dep.worksStore.push({ id: 'w-save', taskId: 't-save', status: 'queued' });
  svc.worksSave();
  const saved = JSON.parse(fs.readFileSync(worksFile(c), 'utf8'));
  assert.deepEqual(saved.works, [{ id: 'w-save', taskId: 't-save', status: 'queued' }]);
});

// ── 会话退役 ────────────────────────────────────────────────────────────────

test('retireTaskSession: 清池、归档会话、旧会话遗留任务退回队列；未知会话 no-op', async () => {
  const c = makeCase();
  c.dep.cfgRef.socialV2.taskPool.maxParallel = 1; // 让 drain 不再派活，隔离断言
  writePool(c, [
    { taskId: 't-a', sessionId: 's-a', dispatchAt: 1, taskShort: '在跑 A', reportTo: 'private:1' },
    { taskId: 't-b', sessionId: 's-b', dispatchAt: 1, taskShort: '在跑 B', reportTo: 'private:2' },
  ]);
  writeLedger([
    runningRow('t-a', 's-a', { task: 'A' }),
    runningRow('t-legacy', 's-a', { task: '同一会话的旧任务' }),
    runningRow('t-b', 's-b', { task: 'B' }),
  ]);
  const svc = createTaskService(c.dep);
  c.dep.taskSessions.add('s-a');
  c.dep.taskCollectors.set('s-a', {});
  await svc.retireTaskSession('s-a', 'done');

  assert.deepEqual(svc.running.map((x) => x.sessionId), ['s-b']);
  assert.deepEqual(readPool(c).map((x) => x.sessionId), ['s-b']);
  assert.deepEqual(c.called('api.stopSessionWork')[0], ['s-a']);
  assert.equal(c.called('api.callUnary').some(([method, payload]) => method === 'workspace/archiveSession' && payload.sessionId === 's-a'), true);
  assert.equal(c.dep.taskSessions.has('s-a'), false);
  assert.equal(c.dep.taskCollectors.has('s-a'), false);
  assert.deepEqual(c.called('api.events.forget')[0], ['s-a']);
  const rows = readLedger();
  assert.equal(rows.find((r) => r.id === 't-legacy').status, 'queued');
  assert.equal(rows.find((r) => r.id === 't-legacy').sessionId, '');
  assert.equal(rows.find((r) => r.id === 't-b').status, 'running');
  assert.match(c.logText(), /会话已归档 s-a（t-a，done）/);
  assert.match(c.logText(), /t-legacy 退回队列/);

  // 未知会话：直接返回，不再调 api
  const before = c.calls.length;
  await svc.retireTaskSession('s-missing', 'noop');
  assert.equal(c.calls.length, before);
});

// ── 看门狗 ──────────────────────────────────────────────────────────────────

test('taskPoolWatchdog: DSH 未就绪 / 池为空时直接返回', async () => {
  const c1 = makeCase();
  writePool(c1, [{ taskId: 't1', sessionId: 's1', dispatchAt: Date.now() - DEFAULT_CAP - 1000, taskShort: 'x', reportTo: '' }]);
  const svc1 = createTaskService({ ...c1.dep, isDshReady: () => false });
  await svc1.taskPoolWatchdog();
  assert.equal(c1.count('api.sessions.list'), 0);

  const c2 = makeCase();
  const svc2 = createTaskService(c2.dep);
  await svc2.taskPoolWatchdog();
  assert.equal(c2.count('api.sessions.list'), 0);
});

test('taskPoolWatchdog: 超时但 DSH 仍在跑 → 顺延计时，不判死', async () => {
  const c = makeCase();
  const dispatchAt = Date.now() - DEFAULT_CAP - 1000;
  writePool(c, [{ taskId: 't-alive', sessionId: 's-alive', dispatchAt, taskShort: '在跑', reportTo: 'private:1' }]);
  writeLedger([runningRow('t-alive', 's-alive')]);
  c.dep.api.sessions.list = async () => [{ sessionId: 's-alive', running: true }];
  const svc = createTaskService(c.dep);
  await svc.taskPoolWatchdog();

  assert.equal(svc.running.length, 1);
  assert.ok(svc.running[0].dispatchAt > dispatchAt, 'dispatchAt 应被顺延');
  assert.equal(readLedger()[0].status, 'running');
  assert.equal(c.count('notifyTaskDone'), 0);
  assert.match(c.logText(), /超时但 DSH 仍在跑，顺延计时/);
});

test('taskPoolWatchdog: 真超时 → 台账 expired + 通知 + 退役会话', async () => {
  const c = makeCase();
  const dispatchAt = Date.now() - DEFAULT_CAP - 1000;
  writePool(c, [{ taskId: 't-dead', sessionId: 's-dead', dispatchAt, taskShort: '超时的活', reportTo: 'private:9' }]);
  writeLedger([runningRow('t-dead', 's-dead', { task: '超时的活', reportTo: 'private:9' })]);
  c.dep.api.sessions.list = async () => [{ sessionId: 's-dead', running: false }];
  const svc = createTaskService(c.dep);
  await svc.taskPoolWatchdog();

  assert.equal(svc.running.length, 0);
  assert.equal(readPool(c).length, 0);
  const row = readLedger()[0];
  assert.equal(row.status, 'expired');
  assert.equal(row.outcome, 'failed');
  assert.match(row.note, /task timeout/);
  assert.deepEqual(c.called('scheduleWakeV2')[0], ['private:9', 'taskDone']);
  assert.match(c.logText(), /完成通知 private:9（超时的活，失败）/);
  assert.match(c.logText(), /超时（.*分钟），归档并出队/);
});

test('taskPoolWatchdog: 台账已终态且会话不跑 → 归档腾槽（ledger-terminal）', async () => {
  const c = makeCase();
  writePool(c, [{ taskId: 't-finished', sessionId: 's-fin', dispatchAt: Date.now() - 1000, taskShort: '已收尾', reportTo: 'private:1' }]);
  writeLedger([runningRow('t-finished', 's-fin', { status: 'finished', outcome: 'success' })]);
  c.dep.api.sessions.list = async () => [{ sessionId: 's-fin', running: false }];
  const svc = createTaskService(c.dep);
  await svc.taskPoolWatchdog();

  assert.equal(svc.running.length, 0);
  assert.equal(readPool(c).length, 0);
  assert.match(c.logText(), /台账已终态、会话不跑了，归档腾槽/);
});

test('taskPoolWatchdog: 回合事件丢了（空闲但台账 running）→ 按「结果未知」失败收尾', async () => {
  const c = makeCase();
  writePool(c, [{ taskId: 't-idle', sessionId: 's-idle', dispatchAt: Date.now() - 120000, taskShort: '丢事件的活', reportTo: 'private:2' }]);
  writeLedger([runningRow('t-idle', 's-idle', { task: '丢事件的活', reportTo: 'private:2' })]);
  c.dep.api.sessions.list = async () => [{ sessionId: 's-idle', running: false }];
  const svc = createTaskService(c.dep);
  await svc.taskPoolWatchdog();

  assert.equal(svc.running.length, 0);
  const row = readLedger()[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.outcome, 'failed');
  assert.match(row.note, /结果未知/);
  assert.deepEqual(c.called('scheduleWakeV2')[0], ['private:2', 'taskDone']);
  assert.match(c.logText(), /完成通知 private:2/);
  assert.match(c.logText(), /会话已空闲但没收到 turn\/end/);
});

// ── 完成通知 ────────────────────────────────────────────────────────────────

test('notifyTaskDone: 写状态并安排 taskDone 唤醒；刚回报过则不重复唤醒', () => {
  const c = makeCase();
  const svc = createTaskService(c.dep);

  svc.notifyTaskDone('private:1', '修好了登录页', '证据：截图', true);
  const st = c.dep.getSocialV2State('private:1');
  assert.equal(st.lastTaskDone.task, '修好了登录页');
  assert.equal(st.lastTaskDone.note, '证据：截图');
  assert.equal(st.lastTaskDone.ok, true);
  assert.ok(st.lastTaskDone.at > 0);
  assert.deepEqual(c.called('scheduleWakeV2')[0], ['private:1', 'taskDone']);
  assert.equal(c.count('saveSocialV2State'), 1);

  // 2 分钟内刚回报过 → 不再唤醒
  c.dep.recentTaskReportAt.set('private:1', Date.now());
  svc.notifyTaskDone('private:1', '第二件事', 'ok', true);
  assert.equal(c.count('scheduleWakeV2'), 1);
  assert.match(c.logText(), /任务会话刚回报过，不重复唤醒/);

  // 没有 reportTo：什么都不做
  const before = c.calls.length;
  svc.notifyTaskDone('', '无主任务', '', true);
  assert.equal(c.calls.length, before);
});

// ── 重启迁移 ────────────────────────────────────────────────────────────────

test('migrateTaskPoolOnce: 恢复在跑会话、判死幽灵任务、迁入旧共享会话、只跑一次', async () => {
  const c = makeCase();
  writePool(c, [{ taskId: 't-old', sessionId: 's-old', dispatchAt: 1, taskShort: '旧在跑', reportTo: '' }]);
  writeLedger([
    runningRow('t-old', 's-old'),
    runningRow('t-ghost', 's-gone', { task: '幽灵任务' }),
    queuedRow('t-q', { task: '排队任务' }),
    runningRow('t-legacy', 's-legacy', { task: '旧共享任务' }),
  ]);
  fs.writeFileSync(path.join(c.STATE_DIR, 'isolated-task.json'), JSON.stringify({ sessionId: 's-legacy' }), 'utf8');
  c.dep.api.sessions.list = async () => [{ sessionId: 's-old' }, { sessionId: 's-legacy' }];
  const svc = createTaskService(c.dep);
  await svc.migrateTaskPoolOnce();

  const followSessions = c.called('api.events.follow').map((a) => a[0]);
  assert.ok(followSessions.includes('s-old'));
  assert.ok(followSessions.includes('s-legacy'));
  assert.equal(c.dep.taskSessions.has('s-old'), true);
  assert.equal(c.dep.taskSessions.has('s-legacy'), true);

  const rows = readLedger();
  assert.equal(rows.find((r) => r.id === 't-ghost').status, 'expired');
  assert.match(rows.find((r) => r.id === 't-ghost').note, /restart cleanup/);
  assert.equal(rows.find((r) => r.id === 't-q').status, 'queued', 'queued 行不动');
  assert.equal(rows.find((r) => r.id === 't-legacy').status, 'running');

  assert.deepEqual(svc.running.map((x) => x.sessionId).sort(), ['s-legacy', 's-old']);
  assert.deepEqual(readPool(c).map((x) => x.sessionId).sort(), ['s-legacy', 's-old']);
  assert.match(c.logText(), /幽灵任务判死/);
  assert.match(c.logText(), /旧任务会话迁入池/);

  // 幂等：第二次直接返回
  const follows = c.count('api.events.follow');
  await svc.migrateTaskPoolOnce();
  assert.equal(c.count('api.events.follow'), follows);
});

test('migrateTaskPoolOnce: 没有 isolated-task.json 时不抛，且不误迁', async () => {
  const c = makeCase();
  writePool(c, [{ taskId: 't-old', sessionId: 's-old', dispatchAt: 1, taskShort: '旧在跑', reportTo: '' }]);
  writeLedger([runningRow('t-old', 's-old')]);
  c.dep.api.sessions.list = async () => [{ sessionId: 's-old' }, { sessionId: 's-legacy' }];
  const svc = createTaskService(c.dep);
  await svc.migrateTaskPoolOnce();
  assert.equal(svc.running.length, 1);
  assert.equal(readPool(c).length, 1);
});

// ── 重启恢复工作台 ──────────────────────────────────────────────────────────

test('reconcileWorksOnBoot: 未完成且没有排队行的活重新入队，带上上次进度；终态/在跑不动', async () => {
  const c = makeCase();
  const runningEntry = { taskId: 't-live', sessionId: 's-live', dispatchAt: 1, taskShort: '在跑', reportTo: '' };
  writePool(c, [
    runningEntry,
    { taskId: 't-fill', sessionId: 's-fill', dispatchAt: 1, taskShort: '占位', reportTo: '' },
  ]); // 池满 → drain 不会再派
  writeLedger([]);
  c.dep.worksStore = [
    {
      id: 'w-active', status: 'running', title: '没跑完的活', taskId: 't-missing', sessionId: '',
      progress: [{ note: '上次做到 X' }], acceptance: '文件：a.txt', reportTo: 'private:1',
    },
    { id: 'w-done', status: 'done', title: '已经做完' },
    { id: 'w-live', status: 'running', title: '在跑', sessionId: 's-live', taskId: 't-live' },
  ];
  const svc = createTaskService(c.dep);
  await svc.reconcileWorksOnBoot();

  const w = c.dep.worksStore[0];
  assert.equal(w.status, 'queued');
  assert.match(w.taskId, /^t/);
  assert.notEqual(w.taskId, 't-missing');
  assert.equal(w.sessionId, '');
  assert.ok(w.updatedAt > 0);

  const rows = readLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, w.taskId);
  assert.equal(rows[0].status, 'queued');
  assert.match(rows[0].task, /^【分身工作/);
  assert.match(rows[0].taskFull, /【上次进度】上次做到 X/);
  const saved = JSON.parse(fs.readFileSync(worksFile(c), 'utf8')).works;
  assert.equal(saved[0].taskId, w.taskId);
  assert.equal(c.dep.worksStore[1].status, 'done');
  assert.equal(c.dep.worksStore[2].taskId, 't-live');
  assert.match(c.logText(), /\[works\] 重启恢复：1 件活重新排队/);
});

test('reconcileWorksOnBoot: DSH 未就绪 → 完全不动', async () => {
  const c = makeCase();
  c.dep.worksStore = [{ id: 'w1', status: 'running', title: '活' }];
  const svc = createTaskService({ ...c.dep, isDshReady: () => false });
  await svc.reconcileWorksOnBoot();
  assert.equal(fs.existsSync(worksFile(c)), false);
  assert.equal(c.logs.length, 0);
});

// ── 投递细节 ────────────────────────────────────────────────────────────────

test('deliverTaskPrompt: ownerRequested 时生成并替换 ownerAgentToken', async () => {
  const c = makeCase();
  c.dep.buildWakePromptV2 = () => 'ctx AGENT-TOK';
  c.dep.getSocialV2State = () => {
    if (!c.socialStates.has('private:1')) {
      c.socialStates.set('private:1', { lastTaskDone: null, agentToken: 'AGENT-TOK', ownerAgentToken: '' });
    }
    return c.socialStates.get('private:1');
  };
  const svc = createTaskService(c.dep);

  await svc.deliverTaskPrompt('sess-9', '任务内容', 'private:1', true);
  const payload = c.called('submitPromptWithTurnSlot')[0][0];
  const text = payload.content[0].text;
  const token = /ctx ([0-9a-f]{48})/.exec(text)?.[1];
  assert.ok(token, '应把 agentToken 换成新生成的 ownerAgentToken');
  assert.deepEqual(c.called('rememberAgentToken')[0], ['private:1', token]);
  assert.equal(c.dep.taskSessions.has('sess-9'), true);
  assert.deepEqual(c.called('api.events.follow')[0], ['sess-9']);
  assert.equal(c.count('saveSocialV2State'), 1);
  assert.ok(!text.includes('AGENT-TOK'), '旧 token 不应留在 prompt 里');

  // 第二次已有 ownerAgentToken：不重复生成
  const before = c.count('rememberAgentToken');
  await svc.deliverTaskPrompt('sess-9', '任务内容', 'private:1', true);
  assert.equal(c.count('rememberAgentToken'), before);
  assert.match(c.called('submitPromptWithTurnSlot')[1][0].content[0].text, new RegExp(token));
});

test('deliverTaskPrompt: 非 ownerRequested 保留原 wake 上下文与任务块', async () => {
  const c = makeCase();
  c.dep.buildWakePromptV2 = () => 'ctx AGENT-TOK';
  c.dep.getSocialV2State = () => ({ lastTaskDone: null, agentToken: 'AGENT-TOK', ownerAgentToken: '' });
  const svc = createTaskService(c.dep);
  await svc.deliverTaskPrompt('sess-3', '普通任务', 'group:5', false);
  const text = c.called('submitPromptWithTurnSlot')[0][0].content[0].text;
  assert.match(text, /^ctx AGENT-TOK\n\n【接手一件事/);
  assert.equal(c.count('rememberAgentToken'), 0);
  assert.equal(c.count('saveSocialV2State'), 0);
});

test('deliverTaskPrompt: 投递被拒时清掉会话登记并把错误抛给调用方', async () => {
  const c = makeCase();
  c.dep.submitPromptWithTurnSlot = async () => ({ result: { ok: false, error: { code: 'denied', message: 'no' } } });
  const svc = createTaskService(c.dep);
  await assert.rejects(
    () => svc.deliverTaskPrompt('sess-4', '任务', 'private:1', false),
    /task prompt 被拒: denied: no/
  );
  assert.equal(c.dep.taskSessions.has('sess-4'), false);
});

test('deliverTaskPrompt: 投递后可用 takeTaskSkillIds 一次性取走技能 id', async () => {
  const c = makeCase();
  const file = c.dep.cfgRef.socialV2.skills.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [{ id: 's1', name: '截图取证', desc: '截图并保存文件', steps: ['打开', '截图'], verify: '文件存在', mastery: 0.7 }],
  }), 'utf8');
  const svc = createTaskService(c.dep);
  await svc.deliverTaskPrompt('sess-5', '帮我做截图取证并保存文件', 'private:1', false);
  assert.deepEqual(svc.takeTaskSkillIds('sess-5'), ['s1']);
  assert.deepEqual(svc.takeTaskSkillIds('sess-5'), []);
  assert.deepEqual(svc.takeTaskSkillIds(''), []);
});
