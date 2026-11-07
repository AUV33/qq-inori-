// wake-schedule 金标：调度层（何时叫她/繁忙暂存/合批 debounce/兜底重试退避）。
// 注意：decideFloor / shouldWake 用真实实现（turn-taking），靠 reason 与状态把判定做成确定性的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeScheduler } from '../src/domain/conversation/wake-schedule.mjs';

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

function makeSched(overrides = {}) {
  const out = { logs: [], floors: [], actions: [], wakes: [], atSplit: 0, cancelled: 0, retries: new Map(), counts: new Map() };
  const st = {
    recentMessages: [{ sender: 'A', text: '在吗', time: Date.now(), isSelf: false }],
    sendTimes: [], wakeConfig: { batchWindowMs: 3000 },
    ...(overrides.st ?? {}),
  };
  const deps = {
    armAtSplit: () => { out.atSplit += 1; },
    cancelReplyCheckV2: () => { out.cancelled += 1; },
    cfg: { socialV2: {}, ...(overrides.cfg ?? {}) },
    computeProactivity: () => 0.2,
    currentMode: 'reserved2',
    getCurrentMode: () => 'reserved2',
    getFreedomPolicy: () => ({}),
    ensureWakeableV2: () => true,
    getSocialV2State: () => st,
    getTuning: () => ({}),
    isConversationBusyV2: () => overrides.busy ?? false,
    isSessionAllowedInCurrentMode: () => overrides.allowed ?? true,
    getLifeState: () => (overrides.life ?? { state: 'awake', debt: 0.1 }),
    loadMoodState: () => (overrides.mood ?? { energy: 0.6 }),
    log: (...args) => out.logs.push(args.map(String).join(' ')),
    logAction: (row) => out.actions.push(row),
    paceBatchMs: (ms) => ms,
    recordFloor: (row) => out.floors.push(row),
    sedimentGroupMemoryIfStale: () => {},
    sendWakePromptV2: async (key, reason) => { out.wakes.push({ key, reason }); },
    socialV2: { paused: overrides.paused ?? false },
    stampReplyPace: (key, reason, s) => { s.lastPace = { holdMs: 0, moodReply: 0.95 }; return s.lastPace; },
    wakePriorityV2: (r) => ({ nameMention: 5, atMention: 5, question: 3, probability: 1, recovery: 2, joinTopic: 1, continueChat: 1 }[String(r).split(':')[0]] ?? 0),
    wakeRetryCounts: out.counts,
    wakeRetryTimers: out.retries,
    ...overrides.deps,
  };
  return { svc: createWakeScheduler(deps), out, st, deps };
}

test('关掉社交 / 已暂停 / 会话不在允许范围 都不排唤醒', () => {
  const off = makeSched({ cfg: { socialV2: { enabled: false } } });
  off.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(off.st.pendingWakeTimer, undefined);

  const paused = makeSched({ paused: true });
  paused.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(paused.st.pendingWakeTimer, undefined);

  const notAllowed = makeSched({ allowed: false });
  notAllowed.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(notAllowed.st.pendingWakeTimer, undefined);
  assert.ok(notAllowed.out.logs.some((l) => l.includes('会话已不在当前模式允许范围内')));
});

test('动机门：群里无人叫的唤醒（probability/recovery）在睡/累时不叫', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [name, opts] of [
    ['睡着', { life: { state: 'sleep', debt: 0 } }],
    ['精力低', { mood: { energy: 0.1 } }],
    ['睡眠债高', { life: { state: 'awake', debt: 0.9 } }],
  ]) {
    const h = makeSched(opts);
    h.svc.scheduleWakeV2('group:1', 'probability:0.3');
    assert.equal(h.st.pendingWakeTimer, undefined, name);
    assert.ok(h.out.logs.some((l) => l.includes('[motive]')), name);
  }
  // 私聊不受动机门限制（用「点她」让唤醒判定确定，避免依赖随机数）
  const priv = makeSched({ life: { state: 'sleep', debt: 0.9 } });
  priv.svc.scheduleWakeV2('private:1', 'nameMention');
  assert.ok(priv.st.pendingWakeTimer);
  assert.equal(priv.out.logs.some((l) => l.includes('[motive]')), false, '私聊不做动机门');
});

test('被点名：必醒、合批计时后真的发出唤醒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched();
  h.st.sleepTimer = setTimeout(() => {}, 100000);
  h.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.ok(h.st.pendingWakeTimer);
  assert.equal(h.out.cancelled, 1, '真实唤醒接管，取消普通回复检查');
  assert.equal(h.st.sleepTimer, null, '顺手清掉睡眠定时器');
  assert.ok(h.out.logs.some((l) => l.includes('计划唤醒')));

  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(h.out.wakes, [{ key: 'group:1', reason: 'nameMention' }]);
});

test('轮次判断：群里没点她且概率不够 → 不排唤醒，但留一行判定记录', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 把「她自己调的阈值」压到 0.6，让非点名的 0.28 稳定低于阈值（不依赖随机数）
  const h = makeSched({
    st: { recentMessages: [], sendTimes: [], wakeConfig: { batchWindowMs: 3000 } },
    deps: { getTuning: () => ({ 'floor.minReply': 0.6 }) },
  });
  h.svc.scheduleWakeV2('group:1', 'probability:0.2');
  assert.equal(h.st.pendingWakeTimer, undefined);
  assert.ok(h.out.logs.some((l) => l.includes('本轮不开口')));
  assert.equal(h.out.floors.length, 1);
  assert.equal(h.out.floors[0].wake, false);
});

test('繁忙：暂存唤醒原因（去重、有界），高优先级挂兜底、软性原因不挂', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({ busy: true });
  h.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(h.st.pendingWakeReasons.length, 1);
  assert.deepEqual(h.st.pendingWakeReasons[0].reason, 'nameMention');
  assert.ok(h.out.actions.some((a) => a.t === 'busy_stash'));
  assert.equal([...h.out.retries.keys()].some((k) => String(k).startsWith('group:1\u0000')), true, '高优先级要挂兜底重试');

  h.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(h.st.pendingWakeReasons.length, 1, '同 reason 同 seq 不重复暂存');

  const soft = makeSched({ busy: true });
  soft.svc.scheduleWakeV2('group:1', 'joinTopic');
  assert.equal([...soft.out.retries.keys()].some((k) => String(k).startsWith('group:1\u0000')), false, '软性自发唤醒不挂兜底');

  const full = makeSched({ busy: true });
  // 用「点她」类原因确保轮次判断一定放行，才能压到队列上限
  for (let i = 0; i < 30; i += 1) full.svc.scheduleWakeV2('group:1', `nameMention:${i}`);
  assert.equal(full.st.pendingWakeReasons.length, 20, '暂存队列有界 20');
});

test('合批 debounce：窗口内又来消息 → 重新计时；原因按优先级升级', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched();
  // 先放一个"低优先级待发唤醒"，再让高优先级的点名进来（模拟先概率后 @）
  h.st.pendingWakeTimer = setTimeout(() => {}, 100000);
  h.st.pendingWakeFirstAt = Date.now();
  h.st.pendingWakeReason = 'joinTopic';
  const first = h.st.pendingWakeTimer;
  h.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.notEqual(h.st.pendingWakeTimer, first, '定时器要重挂（合并同一串话）');
  assert.equal(h.st.pendingWakeReason, 'nameMention', '原因升级到更高优先级');
  assert.ok(h.out.logs.some((l) => l.includes('重新计时')));

  t.mock.timers.tick(3000);
  await flush();
  assert.deepEqual(h.out.wakes[0].reason, 'nameMention');
});

test('合批 debounce：已等时间 + 新窗口超过上限时不再顺延', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = Date.now();
  const h = makeSched({ st: { pendingWakeTimer: setTimeout(() => {}, 100000), pendingWakeFirstAt: now - 25000, pendingWakeReason: 'probability', wakeConfig: { batchWindowMs: 3000 } } });
  const before = h.st.pendingWakeTimer;
  h.svc.scheduleWakeV2('group:1', 'nameMention');
  assert.equal(h.st.pendingWakeTimer, before, '超过 maxDebounce(20s) 就不再重新计时');
});

test('兜底重试：指数退避（base→2x→…，封顶 5 分钟）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({ cfg: { socialV2: { wake: { pendingRetryMs: 20000 } } } });
  h.svc.armWakeRetryForPending('group:1', 'nameMention', 5, Date.now());
  assert.equal(h.out.counts.get('group:1\u00005'), 1);
  assert.equal(h.out.retries.has('group:1\u00005'), true);

  assert.equal(h.out.logs.some((l) => l.includes('20 秒后检查')), true);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(h.out.retries.has('group:1\u00005'), false, '触发后清掉定时器');
  // 这一轮里没有未读（alive=false）→ 认为已处理，清掉计数且不补发
  assert.equal(h.out.counts.has('group:1\u00005'), false);
});

test('兜底重试：超过 12 次放弃并清计数', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched();
  h.out.counts.set('group:1\u00005', 12);
  h.svc.armWakeRetryForPending('group:1', 'nameMention', 5, Date.now());
  assert.equal(h.out.counts.has('group:1\u00005'), false);
  assert.ok(h.out.logs.some((l) => l.includes('放弃本次兜底')));
});

test('兜底重试触发时：该条已出现在上次提示词里就跳过补发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({ st: { lastPromptSeq: 10, recentMessages: [], sendTimes: [] } });
  h.svc.armWakeRetryForPending('group:1', 'nameMention', 5, Date.now());
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(h.out.wakes.length, 0);
  assert.ok(h.out.logs.some((l) => l.includes('已在上次提示词里出现')));
});

// ── 主动机会检查（scheduleProactiveCheckV2）──────────────────────────────────
test('主动检查：关开关 / 暂停 / 非 reserved2 / 会话不允许 都不排', () => {
  const off = makeSched({ cfg: { socialV2: { proactive: { enabled: false } } } });
  off.svc.scheduleProactiveCheckV2('group:1');
  assert.equal(off.st.proactiveTimer, undefined);

  const paused = makeSched({ paused: true });
  paused.svc.scheduleProactiveCheckV2('group:1');
  assert.equal(paused.st.proactiveTimer, undefined);

  const notReserved = makeSched({ deps: { getCurrentMode: () => 'chat' } });
  notReserved.svc.scheduleProactiveCheckV2('group:1');
  assert.equal(notReserved.st.proactiveTimer, undefined);

  const notAllowed = makeSched({ allowed: false });
  notAllowed.svc.scheduleProactiveCheckV2('group:1');
  assert.equal(notAllowed.st.proactiveTimer, undefined);
});

test('主动检查：自由度预算耗尽时不排新检查', () => {
  const h = makeSched({ deps: { getFreedomPolicy: () => ({ initiate: { can: false, reason: 'budget' } }) } });
  h.svc.scheduleProactiveCheckV2('group:1');
  assert.equal(h.st.proactiveTimer, undefined);
  assert.ok(h.out.logs.some((l) => l.includes('[freedom]') && l.includes('budget')));
});

test('主动检查：到点、群已安静够久、概率过关 → 递一次主动机会并重排下一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 概率判定用 Math.random() < prob；夜里还有 ×0.3，不钉死随机数会变成「白天过、23 点后红」的摇摆测试。
  t.mock.method(Math, 'random', () => 0);
  const h = makeSched({
    cfg: { socialV2: { proactive: { checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000, probability: 1, idleThresholdMs: 1000 } } },
    st: { recentMessages: [], sendTimes: [], wakeConfig: {}, lastIncomingAt: Date.now() - 10 * 60000, lastAiReplyAt: Date.now() - 60 * 60000 },
  });
  h.svc.scheduleProactiveCheckV2('group:1');
  assert.ok(h.st.proactiveTimer);
  assert.ok(h.out.logs.some((l) => l.includes('已安排主动机会检查')));

  t.mock.timers.tick(60000);
  await flush();
  assert.deepEqual(h.out.wakes, [{ key: 'group:1', reason: 'proactiveCheck' }]);
  assert.ok(h.st.proactiveTimer, '触发后要重排下一次');
});

test('主动检查：群刚有动静且她自己也没安静够 → 跳过并记 action', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({
    cfg: { socialV2: { proactive: { checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000, probability: 1, idleThresholdMs: 60 * 60000, activeQuietMinMs: 60 * 60000 } } },
    st: { recentMessages: [], sendTimes: [], wakeConfig: {}, lastIncomingAt: Date.now(), lastAiReplyAt: Date.now() },
  });
  h.svc.scheduleProactiveCheckV2('group:1');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(h.out.wakes.length, 0);
  assert.ok(h.out.actions.some((a) => a.t === 'proactive_check' && a.decided === 'skip-idle'));
  assert.ok(h.out.logs.some((l) => l.includes('主动检查跳过')));
});

// ── [JUDGE-WAKE] 本地 3B 意图判定（Q0：让弱指向消息的唤醒决策真正交给判断层）────────
test('[JUDGE-WAKE] 弱指向 anyMessage + 本地3B判为关于她 → 确定性唤醒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({ deps: { judgeWakeIntent: async () => ({ aboutHer: true, target: '你', confidence: 0.9 }) } });
  h.svc.scheduleWakeV2('group:1', 'anyMessage');
  await flush();
  assert.ok(h.st.pendingWakeTimer, '关于她的弱指向消息应安排唤醒计时');
  assert.ok(h.out.floors.some((f) => String(f.why).includes('local-3b 关于她')), '应记录本地3B唤醒原因到判定行');
});

test('[JUDGE-WAKE] 弱指向 anyMessage + 本地3B判为无关 → 静默、不唤醒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeSched({ deps: { judgeWakeIntent: async () => ({ aboutHer: false, target: '别人', confidence: 0.9 }) } });
  h.svc.scheduleWakeV2('group:1', 'anyMessage');
  await flush();
  assert.equal(h.st.pendingWakeTimer, undefined, '无关消息不应安排唤醒');
  assert.ok(h.out.floors.some((f) => String(f.why).includes('local-3b 无关')), '应记录本地3B静默原因到判定行');
});

test('[JUDGE-WAKE] 本地3B置信不足 → 回退原概率逻辑（不强制唤醒/静默）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0); // 概率判定：恒通过
  const h = makeSched({ deps: { judgeWakeIntent: async () => ({ aboutHer: true, target: '你', confidence: 0.2 }) } });
  h.svc.scheduleWakeV2('group:1', 'anyMessage');
  await flush();
  assert.ok(h.st.pendingWakeTimer, '低置信时回退：随机通过则仍唤醒');
  assert.ok(h.out.floors.some((f) => String(f.why).includes('p=')), '回退路径走原概率判定（why 含 p=）');
  assert.ok(!h.out.floors.some((f) => String(f.why).includes('local-3b')), '低置信不应触发本地3B覆盖');
});
