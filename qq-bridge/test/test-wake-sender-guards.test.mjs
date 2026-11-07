// wake-sender 金标（第一层）：唤醒前的所有"该不该叫"闸门——开关/会话轮换/模式/白名单/禁言/繁忙/限流。
// 注意：只覆盖各闸门的早退与副作用；真正拼 prompt 的幸福路径依赖太多，靠线上日志与集成路径覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeSender } from '../src/domain/conversation/wake-sender.mjs';

function makeCtx(overrides = {}) {
  const out = { logs: [], actions: [], retires: [], retries: [], cancelled: 0, saves: 0, extracts: 0, paced: 0 };
  const st = {
    sessionTurns: 0, unread: [], wakeTimes: [], wakeConfig: { batchWindowMs: 3000 },
    recentMessages: [], sendTimes: [],
    ...(overrides.st ?? {}),
  };
  const deps = {
    cfg: { socialV2: {}, ...(overrides.cfg ?? {}) },
    socialV2: { paused: overrides.paused ?? false },
    currentMode: 'reserved2',
    getCurrentMode: () => overrides.mode ?? 'reserved2',
    getSocialV2State: () => st,
    saveSocialV2State: () => { out.saves += 1; },
    retireSession: (key) => out.retires.push(key),
    runMemoryExtractV2: () => { out.extracts += 1; return Promise.resolve(0); },
    applyReplyPace: async () => { out.paced += 1; },
    isSessionAllowedInCurrentMode: () => overrides.allowed ?? true,
    groupMutedUntil: async () => overrides.muteUntil ?? 0,
    isConversationBusyV2: () => overrides.busy ?? false,
    wakePriorityV2: (r) => ({ nameMention: 5, atMention: 5, question: 3, probability: 1, joinTopic: 1 }[String(r).split(':')[0]] ?? 0),
    armWakeRetryForPending: (...args) => out.retries.push(args),
    cancelReplyCheckV2: () => { out.cancelled += 1; },
    log: (...args) => out.logs.push(args.map(String).join(' ')),
    logAction: (row) => out.actions.push(row),
    muteWakeSkipped: (overrides.ctxExtra?.muteWakeSkipped) ?? new Map(),
    // 走到"拼 prompt"这一步说明所有闸门都放行了——用一个可识别的哨兵错误停住，
    // 只断言闸门这一层的副作用（拼装本身依赖太多，不在本文件覆盖范围）。
    buildWakePromptV2: () => { throw new Error('stop-after-guards'); },
    ...overrides.ctxExtra,
  };
  const svc = createWakeSender(deps);
  return { svc, out, st, deps };
}

test('社交总开关关闭 → 直接返回（连轮换都不做）', async () => {
  const h = makeCtx({ cfg: { socialV2: { enabled: false } }, st: { sessionTurns: 999 } });
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.deepEqual(h.out.retires, []);
  assert.equal(h.out.cancelled, 0);
});

test('会话轮换：跑满阈值且没有未读 → 退役旧会话并把回合数清零', async () => {
  const h = makeCtx({ cfg: { socialV2: { context: { maxSessionTurns: 40 } } }, st: { sessionTurns: 40, unread: [] } });
  await assert.rejects(() => h.svc.sendWakePromptV2('group:1', 'nameMention'), /stop-after-guards/);
  assert.deepEqual(h.out.retires, ['group:1']);
  assert.equal(h.st.sessionTurns, 0);
  assert.ok(h.out.saves >= 1);
  assert.ok(h.out.logs.some((l) => l.includes('[SESSION-ROTATE]') && l.includes('换新会话')));
});

test('会话轮换：还有未读且没卡住 → 先不换（带未读换会话会丢上下文）', async () => {
  const h = makeCtx({ cfg: { socialV2: { context: { maxSessionTurns: 40 } } }, st: { sessionTurns: 40, unread: [{ seq: 1 }] } });
  await assert.rejects(() => h.svc.sendWakePromptV2('group:1', 'nameMention'), /stop-after-guards/);
  assert.deepEqual(h.out.retires, []);
  assert.ok(h.out.logs.some((l) => l.includes('等清空再换')));
});

test('会话轮换：未读一直清不空且回合数到两倍阈值 → 强制换（未读不丢，下次唤醒照常喂）', async () => {
  const h = makeCtx({ cfg: { socialV2: { context: { maxSessionTurns: 40 } } }, st: { sessionTurns: 80, unread: [{ seq: 1 }] } });
  await assert.rejects(() => h.svc.sendWakePromptV2('group:1', 'nameMention'), /stop-after-guards/);
  assert.deepEqual(h.out.retires, ['group:1']);
  assert.ok(h.out.logs.some((l) => l.includes('强制换新会话')));
});

test('模式不是 reserved2 / 已暂停 → 不唤醒', async () => {
  const wrongMode = makeCtx({ mode: 'chat' });
  await wrongMode.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.equal(wrongMode.out.paced, 0);

  const paused = makeCtx({ paused: true });
  await paused.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.equal(paused.out.paced, 0);
});

test('会话不在当前模式允许范围 → 记日志后跳过', async () => {
  const h = makeCtx({ allowed: false });
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.ok(h.out.logs.some((l) => l.includes('会话已不在当前模式允许范围内')));
  assert.equal(h.out.cancelled, 0);
});

test('禁言中的群不唤醒（5 分钟内只提示一次）', async () => {
  const h = makeCtx({ muteUntil: Date.now() + 600000 });
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.ok(h.out.logs.some((l) => l.includes('[mute-gate]')));
  assert.equal(h.out.cancelled, 0);

  // 5 分钟内再唤醒一次：不再重复刷同一条提示
  const before = h.out.logs.filter((l) => l.includes('[mute-gate]')).length;
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.equal(h.out.logs.filter((l) => l.includes('[mute-gate]')).length, before);
});

test('会话忙：暂存原因（去重+有界）并给高优先级挂兜底', async () => {
  const h = makeCtx({ busy: true });
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.equal(h.st.pendingWakeReasons.length, 1);
  assert.equal(h.out.retries.length, 1, '点她级别要挂兜底');
  assert.ok(h.out.actions.some((a) => a.t === 'busy_stash'));

  const soft = makeCtx({ busy: true });
  await soft.svc.sendWakePromptV2('group:1', 'joinTopic');
  assert.equal(soft.out.retries.length, 0, '软性自发唤醒不挂兜底');
});

test('唤醒频率超限：跳过但把理由暂存（不许静默丢 @ 的来头）', async () => {
  const now = Date.now();
  const h = makeCtx({
    cfg: { socialV2: { wake: { maxWakePerMinute: 1 } } },
    st: { wakeTimes: [now - 1000], unread: [] },
  });
  await h.svc.sendWakePromptV2('group:1', 'nameMention');
  assert.ok(h.out.logs.some((l) => l.includes('唤醒频率超限')));
  assert.ok(h.out.actions.some((a) => a.t === 'wake_skip'));
  assert.equal(h.st.pendingWakeReasons.length, 1, '理由要暂存，下个唤醒合并');
  assert.equal(h.out.retries.length, 1, '高优先级要挂兜底');
  assert.equal(h.out.cancelled, 0, '限流跳过不算接管');
});
