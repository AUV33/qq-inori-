// social-loop 金标：5 秒心跳里的观望/活跃/试探/退场状态机、延迟投递定时器、群摘要投喂。
// 桩 ctx：所有状态与策略都注入，randInt 固定为 0（延迟 0ms），不碰真实社交实例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialLoop } from '../src/domain/social/social-loop.mjs';

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try { return await fn(); } finally { Math.random = orig; }
}

function blankState() {
  return {
    phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0,
    activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0,
    lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0,
  };
}

function makeCtx(overrides = {}) {
  const rec = {
    logs: [], delivered: [], entered: [], left: [], summaries: [],
    ensured: [], batchCalls: [], proactiveCalls: [], probeCalls: [],
  };
  const social = {
    states: new Map(), recentMessages: new Map(), pendingTimers: new Map(),
    pendingSummaries: new Map(), silentTurns: new Map(), silentContext: new Map(),
    exitingSessions: new Set(), loopTimer: null,
  };
  const state = { sessions: {} };

  const ctx = {
    social,
    cfg: { social: {} },
    log: (m) => rec.logs.push(String(m)),
    randInt: () => 0,
    deliverPrompt: (key, text, opts) => {
      rec.delivered.push({ key, text, opts });
      return Promise.resolve({ ok: true });
    },
    isSocialEnabled: () => true,
    socialState: (key) => {
      if (!social.states.has(key)) social.states.set(key, blankState());
      return social.states.get(key);
    },
    enterActive: (key) => {
      rec.entered.push(key);
      const st = ctx.socialState(key);
      st.phase = 'active';
      st.lastCheckAt = Date.now();
      st.nextCheckAt = Date.now();
      st.lastActiveMessageAt = Date.now();
      st.activeEnteredAt = Date.now();
      st.probeDeadline = 0;
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
    },
    currentRoleHint: () => '【角色】',
    buildProactivePrompt: (key, roleHint) => {
      rec.proactiveCalls.push({ key, roleHint });
      return `PROACTIVE:${key}`;
    },
    triggerActiveDurationExit: () => false,
    isMustReplyText: (t) => String(t).includes('@'),
    appendSummary: (key, sender, text, plain, isOwner, media, messageId) => {
      rec.summaries.push({ key, sender, text, plain, isOwner, media, messageId });
    },
    buildBatchPrompt: (key, msgs, allowSilent) => {
      rec.batchCalls.push({ key, msgs, allowSilent });
      return `BATCH:${msgs.length}:${allowSilent}`;
    },
    leaveActive: (key) => {
      rec.left.push(key);
      social.states.delete(key);
      social.silentContext.delete(key);
    },
    buildProbePrompt: (key) => {
      rec.probeCalls.push({ key });
      return `PROBE:${key}`;
    },
    state,
    ensureSession: async (key) => { rec.ensured.push(key); return `sid:${key}`; },
    mediaHintFor: (key, messageId, media) => (Array.isArray(media) && media.length ? '[M]' : ''),
    buildContextBlock: (key) => `CTX:${key}`,
  };
  const merged = { ...ctx, ...overrides };
  const loop = createSocialLoop(merged);
  return { loop, rec, social, state, merged };
}

function stopLoop(h) {
  if (h.social.loopTimer) clearInterval(h.social.loopTimer);
  h.social.loopTimer = null;
}

const msg = (text, extra = {}) => ({ sender: '阿离', text, plain: text, time: Date.now(), isOwner: false, media: [], messageId: '', ...extra });

test('scheduleSocialReply：按 randInt 延迟投递，定时器登记并在触发后自行摘除', async () => {
  const h = makeCtx({ randInt: () => 2000 });
  h.loop.scheduleSocialReply('group:1', '你好', 2000, 8000, '测试投递', true, ['https://img/1']);
  assert.equal(h.social.pendingTimers.get('group:1').size, 1, '定时器登记在该群下');
  assert.ok(h.rec.logs.some((l) => l === '社交模式：测试投递 group:1，延迟 2s 后投递'));
  assert.equal(h.rec.delivered.length, 0, '延迟期间不投递');

  await wait(2100);
  assert.equal(h.rec.delivered.length, 1);
  assert.deepEqual(h.rec.delivered[0], {
    key: 'group:1', text: '你好', opts: { farewell: true, media: ['https://img/1'] },
  });
  assert.equal(h.social.pendingTimers.has('group:1'), false, '触发后清空该群的定时器集合');
});

test('scheduleSocialReply：media 为 null 归一为 []，投递失败只记日志不抛', async () => {
  const h = makeCtx({
    randInt: () => 0,
    deliverPrompt: () => Promise.reject(new Error('网络炸了')),
  });
  h.loop.scheduleSocialReply('group:1', 'A', 0, 0, '标签', false, null);
  await wait();
  assert.equal(h.rec.delivered.length, 0);
  assert.deepEqual(h.social.pendingTimers.size, 0);
  assert.ok(h.rec.logs.some((l) => l.includes('社交投递异常 group:1: 网络炸了')), `实际日志：${JSON.stringify(h.rec.logs)}`);
});

test('scheduleSocialReply：同群多个定时器并存，各自触发各自摘除', async () => {
  const h = makeCtx();
  h.loop.scheduleSocialReply('group:1', 'A', 0, 0, 'a');
  h.loop.scheduleSocialReply('group:1', 'B', 0, 0, 'b');
  assert.equal(h.social.pendingTimers.get('group:1').size, 2);
  await wait();
  assert.deepEqual(h.rec.delivered.map((d) => d.text), ['A', 'B']);
  assert.equal(h.social.pendingTimers.has('group:1'), false);
  assert.deepEqual(h.rec.delivered[0].opts, { farewell: false, media: [] }, 'farewell 默认 false');
});

test('socialLoopTick：未开启社交模式时整跳跳过（不建状态、不投递）', () => {
  const h = makeCtx({ isSocialEnabled: () => false });
  h.social.recentMessages.set('group:1', [msg('hi', { time: 0 })]);
  h.loop.socialLoopTick();
  assert.equal(h.social.states.size, 0);
  assert.equal(h.rec.entered.length, 0);
  assert.equal(h.rec.delivered.length, 0);
});

test('socialLoopTick：用 states ∪ recentMessages 的 key 驱动状态机', () => {
  const h = makeCtx();
  h.social.recentMessages.set('group:1', [msg('hi')]);
  h.loop.socialLoopTick();
  assert.equal(h.social.states.has('group:1'), true, '只有消息没有状态的群也会建出 idle 状态');
  assert.equal(h.social.states.get('group:1').phase, 'idle');
});

test('socialLoopTick 观望期：群聊久无消息 + 概率命中 → 进活跃并安排主动开话题', async () => {
  const h = makeCtx({ cfg: { social: { proactiveIdleThresholdMs: 60_000, proactiveProbability: 1, proactiveEnabled: true } } });
  h.social.recentMessages.set('group:1', [msg('昨天聊的', { time: Date.now() - 120_000 })]);
  const st = h.merged.socialState('group:1');
  assert.equal(st.proactiveNextCheckAt, 0);

  h.loop.socialLoopTick();
  assert.deepEqual(h.rec.entered, ['group:1'], '概率 1 必进活跃');
  assert.deepEqual(h.rec.proactiveCalls, [{ key: 'group:1', roleHint: '【角色】' }]);
  assert.equal(h.social.pendingTimers.get('group:1').size, 1, '安排了主动开话题的延迟投递');
  assert.ok(h.rec.logs.some((l) => l.includes('观望期主动开话题，进入活跃')));

  await wait();
  assert.equal(h.rec.delivered.length, 1);
  assert.equal(h.rec.delivered[0].text, 'PROACTIVE:group:1');
  assert.deepEqual(h.rec.delivered[0].opts, { farewell: false, media: [] });
});

test('socialLoopTick 观望期：私聊/刚聊过/开关关闭/概率为 0 都不主动开话题', () => {
  // 私聊不做主动开话题
  const priv = makeCtx({ cfg: { social: { proactiveIdleThresholdMs: 1, proactiveProbability: 1 } } });
  priv.social.recentMessages.set('private:1', [msg('hi', { time: Date.now() - 10_000 })]);
  priv.loop.socialLoopTick();
  assert.equal(priv.rec.entered.length, 0);

  // 最近刚有消息：未到 idle 阈值
  const recent = makeCtx({ cfg: { social: { proactiveIdleThresholdMs: 60_000, proactiveProbability: 1 } } });
  recent.social.recentMessages.set('group:1', [msg('刚说的')]);
  recent.loop.socialLoopTick();
  assert.equal(recent.rec.entered.length, 0);
  assert.equal(recent.merged.socialState('group:1').proactiveNextCheckAt, 0, '没达到 idle 阈值不安排下一次检查');

  // 配置关闭
  const off = makeCtx({ cfg: { social: { proactiveIdleThresholdMs: 1, proactiveProbability: 1, proactiveEnabled: false } } });
  off.social.recentMessages.set('group:1', [msg('老消息', { time: 1 })]);
  off.loop.socialLoopTick();
  assert.equal(off.rec.entered.length, 0);

  // 概率 0：只推进下一次检查时间
  const unlucky = makeCtx({ cfg: { social: { proactiveIdleThresholdMs: 1, proactiveProbability: 0 } } });
  unlucky.social.recentMessages.set('group:1', [msg('老消息', { time: 1 })]);
  const before = Date.now();
  unlucky.loop.socialLoopTick();
  assert.equal(unlucky.rec.entered.length, 0);
  const st = unlucky.merged.socialState('group:1');
  assert.ok(st.proactiveNextCheckAt >= before, 'randInt 桩为 0 → 下次检查=本次心跳时刻');
});

test('socialLoopTick 活跃期：到点把新消息（含沉默队列）并成一批投递', async () => {
  const h = makeCtx();
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = Date.now() - 10_000;
  st.nextCheckAt = Date.now() - 1;
  st.lastActiveMessageAt = Date.now() - 10_000;
  h.social.recentMessages.set('group:1', [
    msg('旧的', { time: st.lastCheckAt - 1 }),
    msg('新1 @满满', { media: ['https://img/a'] }),
    msg('新2', { media: ['https://img/b'] }),
  ]);
  h.social.silentContext.set('group:1', [msg('之前看到没接的', { time: st.lastCheckAt - 5 })]);

  h.loop.socialLoopTick();
  const batch = h.rec.batchCalls[0];
  assert.equal(batch.msgs.length, 3, '沉默队列也带上');
  assert.deepEqual(batch.msgs.map((m) => m.text), ['之前看到没接的', '新1 @满满', '新2']);
  assert.equal(batch.allowSilent, false, '有 @ 点名必须回，不给 SILENT 出口');
  assert.equal(h.social.silentContext.has('group:1'), false, '带出去后清空沉默队列');
  assert.equal(st.lastCheckAt > Date.now() - 1000, true);
  assert.equal(h.rec.delivered.length, 0, '投递走延迟定时器');
  assert.equal(h.social.pendingTimers.get('group:1').size, 1);
  assert.ok(h.rec.logs.some((l) => l.includes('检测到 2 条新消息（含 1 条之前沉默的）')));

  await wait();
  assert.equal(h.rec.delivered[0].text, 'BATCH:3:false');
  assert.deepEqual(h.rec.delivered[0].opts.media, ['https://img/a', 'https://img/b'], '批内媒体合并');
});

test('socialLoopTick 活跃期：还没到下一次检查点就什么都不做', () => {
  const h = makeCtx();
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = 0;
  st.nextCheckAt = Date.now() + 60_000;
  h.social.recentMessages.set('group:1', [msg('新消息')]);
  h.loop.socialLoopTick();
  assert.equal(h.rec.batchCalls.length, 0);
  assert.equal(h.rec.delivered.length, 0);
  assert.equal(st.lastCheckAt, 0, '没到点不推进检查水位');
});

test('socialLoopTick 活跃期：引用她本人也算必须回；私聊一律必须回', () => {
  const quoted = makeCtx();
  const st = quoted.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = Date.now() - 1000;
  st.nextCheckAt = 0;
  quoted.social.recentMessages.set('group:1', [msg('普通闲聊', { quoteTargetIsSelf: true })]);
  quoted.loop.socialLoopTick();
  assert.equal(quoted.rec.batchCalls[0].allowSilent, false);

  const priv = makeCtx();
  const st2 = priv.merged.socialState('private:1');
  st2.phase = 'active';
  st2.lastCheckAt = Date.now() - 1000;
  st2.nextCheckAt = 0;
  priv.social.recentMessages.set('private:1', [msg('随便聊聊')]);
  priv.loop.socialLoopTick();
  assert.equal(priv.rec.batchCalls[0].allowSilent, false, '私聊没有 SILENT 出口');
});

test('socialLoopTick 活跃期选择性沉默：普通闲聊按概率跳过，转摘要并留到下次', async () => {
  const h = makeCtx({ cfg: { social: { skipProbability: 1 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = Date.now() - 1000;
  st.nextCheckAt = 0;
  st.lastAiReplyAt = 0;
  h.social.recentMessages.set('group:1', [
    msg('闲聊1', { messageId: 'm1' }),
    msg('闲聊2', { messageId: 'm2' }),
  ]);

  await withRandom(0, () => h.loop.socialLoopTick());
  assert.equal(h.rec.batchCalls.length, 0, '沉默了就不投递');
  assert.equal(h.rec.delivered.length, 0);
  assert.equal(h.social.silentContext.get('group:1').length, 2, '看到但没接，留到下次');
  assert.deepEqual(h.rec.summaries.map((s) => s.messageId), ['m1', 'm2'], '沉默消息进摘要队列');
  assert.ok(h.rec.logs.some((l) => l.includes('跳过 2 条普通消息（选择性沉默，skip=0.80）')));
});

test('socialLoopTick 活跃期：刚回过话的 60 秒内不沉默（避免活跃到一半突然不接）', async () => {
  const h = makeCtx({ cfg: { social: { skipProbability: 1 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = Date.now() - 1000;
  st.nextCheckAt = 0;
  st.lastAiReplyAt = Date.now();
  h.social.recentMessages.set('group:1', [msg('闲聊')]);

  await withRandom(0, () => h.loop.socialLoopTick());
  assert.equal(h.rec.batchCalls.length, 1, 'skipProb 归零，必回');
  assert.equal(h.rec.batchCalls[0].allowSilent, true, '普通闲聊给 SILENT 出口');
  await wait();
  assert.equal(h.rec.delivered[0].text, 'BATCH:1:true');
});

test('socialLoopTick 活跃期：silentContext 只保留最近 30 条', async () => {
  const h = makeCtx({ cfg: { social: { skipProbability: 1 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.lastCheckAt = Date.now() - 1000;
  st.nextCheckAt = 0;
  h.social.silentContext.set('group:1', Array.from({ length: 28 }, (_, i) => msg(`旧沉默${i}`)));
  h.social.recentMessages.set('group:1', Array.from({ length: 5 }, (_, i) => msg(`新${i}`)));
  await withRandom(0, () => h.loop.socialLoopTick());
  assert.equal(h.social.silentContext.get('group:1').length, 30);
  assert.equal(h.social.silentContext.get('group:1').at(-1).text, '新4');
});

test('socialLoopTick 活跃期冷场：概率命中 → 进试探并延迟说一句', async () => {
  const h = makeCtx({ cfg: { social: { idleWindowMs: 1000, idleRetryProbability: 0.25, idleRetryWaitMs: 5000 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.nextCheckAt = 0;
  st.lastCheckAt = Date.now() - 5000;
  st.lastActiveMessageAt = Date.now() - 5000;

  const before = Date.now();
  await withRandom(0, () => h.loop.socialLoopTick());
  assert.equal(st.phase, 'probing');
  assert.ok(st.probeDeadline >= before + 5000, '试探截止 = 心跳时刻 + idleRetryWaitMs');
  assert.ok(st.probeDeadline <= Date.now() + 5000);
  assert.deepEqual(h.rec.probeCalls, [{ key: 'group:1' }]);
  assert.ok(h.rec.logs.some((l) => l.includes('冷场，AI 试探性说一句')));
  await wait();
  assert.equal(h.rec.delivered[0].text, 'PROBE:group:1');
});

test('socialLoopTick 活跃期冷场：概率未命中 → 回观望', async () => {
  const h = makeCtx({ cfg: { social: { idleWindowMs: 1000, idleRetryProbability: 0.25 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.nextCheckAt = 0;
  st.lastCheckAt = Date.now() - 5000;
  st.lastActiveMessageAt = Date.now() - 5000;

  await withRandom(0.9, () => h.loop.socialLoopTick());
  assert.deepEqual(h.rec.left, ['group:1']);
  assert.ok(h.rec.logs.some((l) => l.includes('冷场，回到观望')));
  assert.equal(h.social.states.has('group:1'), false);
});

test('socialLoopTick 活跃期：还没安静够就不冷场也不重排', () => {
  const h = makeCtx({ cfg: { social: { idleWindowMs: 180_000 } } });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.nextCheckAt = 0;
  st.lastCheckAt = Date.now();
  st.lastActiveMessageAt = Date.now() - 1000;
  h.loop.socialLoopTick();
  assert.equal(st.phase, 'active');
  assert.equal(h.rec.left.length, 0);
  assert.equal(h.rec.delivered.length, 0);
});

test('socialLoopTick 活跃期：活跃超时优先于回复判定，直接 continue', () => {
  const h = makeCtx({ triggerActiveDurationExit: () => true });
  const st = h.merged.socialState('group:1');
  st.phase = 'active';
  st.nextCheckAt = 0;
  h.social.recentMessages.set('group:1', [msg('新消息')]);
  h.loop.socialLoopTick();
  assert.equal(h.rec.batchCalls.length, 0, '退场判定命中就不再安排回复');
  assert.equal(h.rec.delivered.length, 0);
});

test('socialLoopTick 试探期：超时无回应 → 回观望；未超时不动', () => {
  const h = makeCtx();
  const st = h.merged.socialState('group:1');
  st.phase = 'probing';
  st.probeDeadline = Date.now() + 60_000;
  h.loop.socialLoopTick();
  assert.equal(st.phase, 'probing', '没到 deadline 保持试探');
  assert.equal(h.rec.left.length, 0);

  const due = makeCtx();
  const st2 = due.merged.socialState('group:1');
  st2.phase = 'probing';
  st2.probeDeadline = Date.now() - 1;
  due.loop.socialLoopTick();
  assert.deepEqual(due.rec.left, ['group:1']);
  assert.ok(due.rec.logs.some((l) => l.includes('试探无回应，回到观望')));
});

test('socialLoopTick 退场中：60 分钟兜底强制回观望并清退场会话标记', () => {
  const h = makeCtx();
  const st = h.merged.socialState('group:1');
  st.phase = 'exiting';
  st.activeExitAt = Date.now() - 61 * 60 * 1000;
  st.activeDeadlineAt = 123;
  h.state.sessions['group:1'] = 'sid-9';
  h.social.exitingSessions.add('sid-9');

  h.loop.socialLoopTick();
  assert.equal(st.phase, 'idle');
  assert.equal(st.activeDeadlineAt, 0);
  assert.equal(st.activeExitAt, 0);
  assert.equal(h.social.exitingSessions.has('sid-9'), false);
  assert.ok(h.rec.logs.some((l) => l.includes('退场等待超时（60 分钟），强制回到观望')));
});

test('socialLoopTick 退场中：未超时就保持退场，不做参与/冷场判定', () => {
  const h = makeCtx();
  const st = h.merged.socialState('group:1');
  st.phase = 'exiting';
  st.activeExitAt = Date.now() - 1000;
  h.social.recentMessages.set('group:1', [msg('新消息')]);
  h.loop.socialLoopTick();
  assert.equal(st.phase, 'exiting');
  assert.equal(h.rec.batchCalls.length, 0);
  assert.equal(h.rec.delivered.length, 0);
});

test('startSocialLoop：5 秒心跳，重复启动会先清掉旧定时器', () => {
  const h = makeCtx();
  h.loop.startSocialLoop();
  const first = h.social.loopTimer;
  assert.ok(first && typeof first.unref === 'function');
  h.loop.startSocialLoop();
  const second = h.social.loopTimer;
  assert.notEqual(second, first, '重启不叠加心跳');
  stopLoop(h);
  assert.equal(h.social.loopTimer, null);
});

test('flushSummaries：按 key 投喂摘要（静默、带媒体与最近对话），成功后清条目', async () => {
  const h = makeCtx();
  h.social.pendingSummaries.set('group:1', {
    since: 1,
    items: [
      { sender: '阿离', text: 'A', plain: 'A', isOwner: false, media: ['https://img/1'], messageId: 'm1' },
      { sender: '他', text: 'B', plain: 'B', isOwner: true, media: [], messageId: 'm2' },
    ],
  });

  await h.loop.flushSummaries('group:1');
  assert.deepEqual(h.rec.ensured, ['group:1']);
  assert.equal(h.rec.delivered.length, 1);
  const d = h.rec.delivered[0];
  assert.equal(d.key, 'group:1');
  assert.deepEqual(d.opts, { silent: true, media: ['https://img/1'] }, '摘要静默投喂，媒体合并');
  assert.ok(d.text.startsWith('【角色】\n\n'), '角色提示打头');
  assert.ok(d.text.includes('【群聊摘要】过去一段时间群里发生了这些'));
  assert.ok(d.text.includes('阿离：A[M]'));
  assert.ok(d.text.includes('【他】他：B'), 'owner 前缀');
  assert.ok(d.text.includes('【最近对话】\nCTX:group:1'));
  assert.ok(d.text.includes('你不需要回复'));
  assert.ok(h.rec.logs.some((l) => l.includes('已投喂群聊摘要 (group:1) 2 条')));
  assert.equal(h.social.pendingSummaries.has('group:1'), false, '投喂成功的空条目被清掉');
  assert.equal(h.social.silentTurns.get('sid:group:1').length, 1, '登记了静默回合，等 turn 结束时消费');
});

test('flushSummaries：指定不存在的 key 什么都不做', async () => {
  const h = makeCtx();
  await h.loop.flushSummaries('group:none');
  assert.equal(h.rec.ensured.length, 0);
  assert.equal(h.rec.delivered.length, 0);
});

test('flushSummaries：条目为空则跳过；全量模式顺手清掉空条目', async () => {
  const h = makeCtx();
  h.social.pendingSummaries.set('group:empty', { since: 1, items: [] });
  h.social.pendingSummaries.set('group:full', { since: 1, items: [{ sender: 'a', text: 'x', media: [] }] });
  await h.loop.flushSummaries();
  assert.equal(h.rec.delivered.length, 1);
  assert.equal(h.social.pendingSummaries.has('group:empty'), false);
  assert.equal(h.social.pendingSummaries.has('group:full'), false);
});

test('flushSummaries：投递被拒 → 撤销静默回合标记、保留摘要待重试', async () => {
  const h = makeCtx({ deliverPrompt: () => Promise.resolve({ ok: false, error: '预算拒绝' }) });
  h.social.pendingSummaries.set('group:1', { since: 1, items: [{ sender: 'a', text: 'x', media: [], messageId: 'm1' }] });
  await h.loop.flushSummaries('group:1');
  assert.equal(h.social.silentTurns.has('sid:group:1'), false, '被拒不能留下静默回合');
  assert.equal(h.social.pendingSummaries.get('group:1').items.length, 1, '摘要保留等下次');
  assert.ok(h.rec.logs.some((l) => l.includes('摘要投喂被拒 (group:1): 预算拒绝')));
});

test('flushSummaries：投递抛错/建会话失败 → 各自记日志，不丢摘要', async () => {
  const thrown = makeCtx({ deliverPrompt: () => Promise.reject(new Error('DSH 掉线')) });
  thrown.social.pendingSummaries.set('group:1', { since: 1, items: [{ sender: 'a', text: 'x', media: [] }] });
  await thrown.loop.flushSummaries('group:1');
  assert.equal(thrown.social.silentTurns.has('sid:group:1'), false);
  assert.equal(thrown.social.pendingSummaries.get('group:1').items.length, 1);
  assert.ok(thrown.rec.logs.some((l) => l.includes('摘要投喂失败 (group:1): DSH 掉线')));

  const noSession = makeCtx({ ensureSession: async () => { throw new Error('模式不允许'); } });
  noSession.social.pendingSummaries.set('group:2', { since: 1, items: [{ sender: 'a', text: 'x', media: [] }] });
  await noSession.loop.flushSummaries('group:2');
  assert.equal(noSession.rec.delivered.length, 0);
  assert.equal(noSession.social.pendingSummaries.get('group:2').items.length, 1);
  assert.ok(noSession.rec.logs.some((l) => l.includes('摘要投喂创建会话失败 (group:2): 模式不允许')));
});

test('flushSummaries：一个 key 失败不影响后续 key', async () => {
  let n = 0;
  const h = makeCtx({
    ensureSession: async (key) => {
      n += 1;
      if (n === 1) throw new Error('第一条炸了');
      return `sid:${key}`;
    },
  });
  h.social.pendingSummaries.set('group:1', { since: 1, items: [{ sender: 'a', text: 'x', media: [] }] });
  h.social.pendingSummaries.set('group:2', { since: 1, items: [{ sender: 'b', text: 'y', media: [] }] });
  await h.loop.flushSummaries();
  assert.deepEqual(h.rec.delivered.map((d) => d.key), ['group:2']);
  assert.equal(h.social.pendingSummaries.has('group:2'), false);
  assert.equal(h.social.pendingSummaries.has('group:1'), true, '失败的那条留着');
});

test('flushSummaries：同一会话第二次摘要会追加静默回合标记', async () => {
  const h = makeCtx();
  h.social.pendingSummaries.set('group:1', { since: 1, items: [{ sender: 'a', text: 'x', media: [] }] });
  await h.loop.flushSummaries('group:1');
  h.social.pendingSummaries.set('group:1', { since: 2, items: [{ sender: 'a', text: 'y', media: [] }] });
  await h.loop.flushSummaries('group:1');
  assert.equal(h.social.silentTurns.get('sid:group:1').length, 2, '两条待消费的静默回合');
});
