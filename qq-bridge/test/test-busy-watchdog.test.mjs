// busy-watchdog 金标：让位取消的判定条件、幽灵回合自愈、busy 硬上限、等待时间不计入预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBusyWatchdog } from '../src/domain/conversation/busy-watchdog.mjs';

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const conversations = new Map();
  const state = { sessions: {} };
  const v2TurnStartAt = new Map();
  const maps = {
    busySinceMs: new Map(), waitToolCalls: new Map(), waitStartAt: new Map(), waitTurnMs: new Map(),
    turnToolStats: new Map(), collectors: new Map(), promptQueues: new Map(),
    pendingWakeKeys: new Set(), sendToolSucceeded: new Set(), autoCancelled: new Set(),
    wakeRetryTimers: new Map(), wakeRetryCounts: new Map(),
  };
  const out = { logs: [], actions: [], scheduled: [], cancelled: [], saved: 0, rpc: [], leased: 0 };
  const svc = createBusyWatchdog({
    cfg: overrides.cfg ?? { socialV2: { wake: { busyCheckMs: 30000, busyStaleMs: 120000, turnMaxMs: 30000, busyCapMs: 600000 } } },
    getDshReady: () => overrides.ready ?? true,
    taskPoolWatchdog: () => { out.pool = (out.pool ?? 0) + 1; return Promise.resolve(); },
    migrateTaskPoolOnce: () => { out.migrate = (out.migrate ?? 0) + 1; return Promise.resolve(); },
    pruneMissingSessions: () => { out.prune = (out.prune ?? 0) + 1; return Promise.resolve(); },
    socialV2: { conversations },
    getSocialV2State: () => overrides.st ?? {},
    isConversationBusyV2: () => overrides.busy ?? true,
    busySinceMs: maps.busySinceMs,
    log: (m) => out.logs.push(String(m)),
    state,
    collectors: maps.collectors,
    v2TurnStartAt,
    pendingWakeKeys: maps.pendingWakeKeys,
    promptQueues: maps.promptQueues,
    disarmPendingWakeLease: () => { out.leased += 1; },
    wakePriorityV2: (r) => ({ 'own-life': 5, recovery: 3, boredom: 1 }[r] ?? 0),
    scheduleWakeV2: (key, reason) => out.scheduled.push({ key, reason }),
    saveSocialV2State: () => { out.saved += 1; },
    api: {
      sessions: { list: async () => (overrides.runningList ?? []) },
      callUnary: async (method, payload) => {
        out.rpc.push({ method, payload });
        if (overrides.cancelFails) throw new Error('取消失败');
        return { result: { ok: true, value: {} } };
      },
    },
    unwrap: (r) => { if (r?.items) return r.items; return r; },
    getWakeRetryTimers: () => maps.wakeRetryTimers,
    getWakeRetryCounts: () => maps.wakeRetryCounts,
    turnToolStats: maps.turnToolStats,
    sendToolSucceededSessions: maps.sendToolSucceeded,
    getAutoCancelledKeys: () => maps.autoCancelled,
    waitToolCalls: maps.waitToolCalls,
    waitStartAt: maps.waitStartAt,
    turnWaitMs: maps.waitTurnMs,
    logAction: (row) => out.actions.push(row),
    ...overrides.ctxExtra,
  });
  return { svc, out, conversations, state, v2TurnStartAt, maps };
}

function tick(h) {
  h.svc.startBusyWatchdog();
  return flush();
}

test('startBusyWatchdog：DSH 未就绪时这一拍什么都不做', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ ready: false });
  h.conversations.set('group:1', {});
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.equal(h.out.pool, undefined);
  assert.equal(h.out.scheduled.length, 0);
});

test('startBusyWatchdog：就绪时每拍巡检任务池，每 10 分钟清一次会话映射', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ busy: false });
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.equal(h.out.pool, 1);
  assert.equal(h.out.prune, 1);
  for (let i = 0; i < 20; i += 1) { t.mock.timers.tick(30000); }
  await flush();
  assert.equal(h.out.pool, 21);
  assert.ok(h.out.prune < h.out.pool, '会话清理每 10 分钟一次，不是每拍');
});

test('让位取消：长 turn + 期间来了新消息 → cancel + 记 action + 重排唤醒', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const startedAt = Date.now() - 40_000;
  const h = makeCtx({
    st: { unread: [{ time: Date.now() - 10_000 }], pendingWakeReasons: [{ reason: 'own-life' }, { reason: 'boredom' }] },
  });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', startedAt);
  h.maps.turnToolStats.set('sid-1', { ok: 2, fail: 1 });
  await tick(h);
  t.mock.timers.tick(30000); await flush();

  assert.deepEqual(h.out.rpc.map((r) => r.method), ['session/cancel']);
  assert.equal(h.out.auto0 === undefined, true);
  assert.ok(h.maps.autoCancelled.has('group:1'), '要标成系统让位取消（不回「已停止」）');
  assert.equal(h.out.actions.length, 1);
  assert.equal(h.out.actions[0].why, 'busy-watch');
  assert.equal(h.out.scheduled[0].reason, 'own-life', '按优先级重排最高的一条');
  assert.equal(h.v2TurnStartAt.has('sid-1'), false);
  assert.ok(h.out.logs.some((l) => l.includes('让位取消')));
});

test('让位取消：期间没有新消息就不打断（让她跑完）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ st: { unread: [] } });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 40_000);
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.equal(h.out.rpc.length, 0);
  assert.equal(h.v2TurnStartAt.has('sid-1'), true);
});

test('让位取消：已经开口说话的回合只在超过 3 倍预算时才收场', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ st: { unread: [{ time: Date.now() - 5_000 }] } });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 40_000);
  h.maps.sendToolSucceeded.add('sid-1');
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.equal(h.out.rpc.length, 0, '40s < 3×30s，不打断正在说的话');

  const hard = makeCtx({ st: { unread: [{ time: Date.now() - 5_000 }] } });
  hard.conversations.set('group:1', {});
  hard.state.sessions['group:1'] = 'sid-1';
  hard.v2TurnStartAt.set('sid-1', Date.now() - 5 * 60_000);
  hard.maps.sendToolSucceeded.add('sid-1');
  await tick(hard);
  t.mock.timers.tick(30000); await flush();
  assert.equal(hard.out.rpc.length, 1, '超过硬上限必须收场');
});

test('等待时间不计入预算：等 25s 的 40s turn 不该被掐', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ st: { unread: [{ time: Date.now() - 5_000 }] } });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 40_000);
  h.maps.waitTurnMs.set('sid-1', 25_000);
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.equal(h.out.rpc.length, 0, '有效忙碌只有 15s');
});

test('幽灵回合：busy 但没有 turn 开始标记，DSH 不在跑 → 强制解除并补唤醒', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ st: { pendingWakeReasons: [{ reason: 'recovery' }] }, runningList: [{ sessionId: 'sid-1', running: false }] });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.maps.busySinceMs.set('group:1', Date.now() - 20_000);
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.ok(h.out.logs.some((l) => l.includes('但没有进行中的回合')));
  assert.equal(h.out.scheduled[0].reason, 'recovery');
  assert.equal(h.maps.busySinceMs.has('group:1'), false);
});

test('幽灵回合：有批量唤醒定时器在等 / DSH 还在跑 都不解除', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const waiting = makeCtx({ st: { pendingWakeTimer: 'timer' } });
  waiting.conversations.set('group:1', {});
  waiting.state.sessions['group:1'] = 'sid-1';
  waiting.maps.busySinceMs.set('group:1', Date.now() - 20_000);
  await tick(waiting);
  t.mock.timers.tick(30000); await flush();
  assert.equal(waiting.out.scheduled.length, 0);

  const running = makeCtx({ runningList: [{ sessionId: 'sid-1', running: true }] });
  running.conversations.set('group:1', {});
  running.state.sessions['group:1'] = 'sid-1';
  running.maps.busySinceMs.set('group:1', Date.now() - 20_000);
  await tick(running);
  t.mock.timers.tick(30000); await flush();
  assert.equal(running.out.scheduled.length, 0);
  assert.equal(running.maps.busySinceMs.has('group:1'), true);
});

test('busy 硬上限：持续超过 10 分钟强制解除全部本地 busy 源', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ st: { pendingWakeReasons: [{ reason: 'own-life' }] } });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.maps.busySinceMs.set('group:1', Date.now() - 11 * 60_000);
  h.v2TurnStartAt.set('sid-1', Date.now() - 11 * 60_000);
  h.maps.promptQueues.set('group:1', { running: true, queue: [{}, {}] });
  h.maps.pendingWakeKeys.add('group:1');
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.ok(h.out.logs.some((l) => l.includes('强制解除')));
  assert.equal(h.out.scheduled[0].reason, 'own-life');
  assert.equal(h.maps.promptQueues.has('group:1'), false, '队列要清掉');
  assert.equal(h.maps.pendingWakeKeys.has('group:1'), false);
  assert.equal(h.out.saved, 1);
});

test('staleMs 后 DSH 侧不在跑 → 解除 busy；查询失败则这一轮不动', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  // turnMaxMs 放到 60s，让 hardCap(240s) 不至于先触发；busy 150s 正好落在 stale(120s) 之后
  const h = makeCtx({
    runningList: [{ sessionId: 'sid-1', running: false }],
    cfg: { socialV2: { wake: { busyCheckMs: 30000, busyStaleMs: 120000, turnMaxMs: 60000, busyCapMs: 900000 } } },
  });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 150_000);
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.ok(h.out.logs.some((l) => l.includes('DSH 侧不在跑，强制解除 busy')));

  const broken = makeCtx({
    ctxExtra: { api: { sessions: { list: async () => { throw new Error('查不到'); } }, callUnary: async () => ({}) } },
    cfg: { socialV2: { wake: { busyCheckMs: 30000, busyStaleMs: 120000, turnMaxMs: 60000, busyCapMs: 900000 } } },
  });
  broken.conversations.set('group:1', {});
  broken.state.sessions['group:1'] = 'sid-1';
  broken.v2TurnStartAt.set('sid-1', Date.now() - 150_000);
  await tick(broken);
  t.mock.timers.tick(30000); await flush();
  assert.equal(broken.v2TurnStartAt.has('sid-1'), true, '查不到就先当在跑，下轮再试');
});

test('取消失败也要继续走兜底（记日志、清状态、重排）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = makeCtx({ cancelFails: true, st: { unread: [{ time: Date.now() - 1_000 }] } });
  h.conversations.set('group:1', {});
  h.state.sessions['group:1'] = 'sid-1';
  h.v2TurnStartAt.set('sid-1', Date.now() - 40_000);
  await tick(h);
  t.mock.timers.tick(30000); await flush();
  assert.ok(h.out.logs.some((l) => l.includes('取消长 turn 失败')));
  assert.equal(h.out.scheduled.length, 1);
  assert.equal(h.v2TurnStartAt.has('sid-1'), false);
});
