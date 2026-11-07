// social-core 金标：社交状态机入口、上下文块与提示词拼装、活跃退场，
// 以及「每个会话串行投递」的 prompt 队列与投递门（暂停/未就绪/会话重置）。
// 全部走注入桩 ctx：不碰真实 social 实例、不发提示、不读盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialCore } from '../src/domain/social/social-core.mjs';

const tickAsync = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const rec = {
    logs: [], scheduled: [], notices: [], audited: [], retried: [], recorded: [],
    noted: [], disarmed: [], ensured: [], submits: [], resolvedMedia: [],
  };
  const social = {
    states: new Map(), recentMessages: new Map(), pendingSummaries: new Map(),
    pendingTimers: new Map(), silentContext: new Map(), silentTurns: new Map(), exitingSessions: new Set(),
  };
  const socialV2 = { paused: false, conversations: new Map() };
  const promptQueues = new Map();
  const queued = new Map();
  const pendingWakeKeys = new Set();
  const messageMediaStore = new Map();
  const v2states = new Map();

  const ctx = {
    getCurrentMode: () => 'reserved',
    cfg: { social: {}, socialV2: {}, ownerQQ: 10001 },
    social, socialV2,
    selfNickname: '满满',
    truncateText: (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s)),
    mediaHintFor: (key, messageId, media) => (Array.isArray(media) && media.length ? `[媒体×${media.length}]` : ''),
    randInt: (min) => min,
    lifeTimePre: () => '[LIFE] 晚上好',
    ruminationPre: () => '',
    DIRECTION_HINT: '[方向指引]',
    SPACE_SPLIT_HINT: '[分段]',
    SILENT_MARKER: '[SILENT]',
    currentRoleHint: () => '【角色】',
    getScheduleSocialReply: () => (key, text, min, max, label, farewell, media) => {
      rec.scheduled.push({ key, text, min, max, label, farewell, media });
    },
    log: (m) => rec.logs.push(String(m)),
    messageMediaStore,
    promptQueues,
    isSessionAllowedInCurrentMode: () => true,
    pendingWakeKeys,
    disarmPendingWakeLease: (key) => rec.disarmed.push(key),
    getDshReady: () => true,
    queued,
    QUEUE_MAX: 3,
    ownerLaneFor: () => false,
    OWNER_LANE_SUFFIX: '#owner',
    ensureSession: async (key) => { rec.ensured.push(key); return `sid:${key}`; },
    enqueueForRetry: (key, promptText, opts) => rec.retried.push({ key, promptText, opts }),
    buildFreedomPolicy: () => ({ perms: ['说或不说'] }),
    formatFreedomLog: () => '【自由日志】',
    recordFreedomPolicy: (policy, meta) => rec.recorded.push({ policy, meta }),
    stateDataPath: (f) => `/state/${f}`,
    renderFreedomPermission: () => '[FREEDOM]',
    renderAgencyBlock: () => '[AGENCY]',
    renderPragmaticContext: () => '[PRAGMA]',
    buildWakePromptV2: (key, reason) => `WAKE[${key}][${reason}]`,
    buildWakeSnapshotV2: () => null,
    renderWakeSnapshotV2: (s) => s?.text ?? '',
    getSocialV2State: (key) => {
      if (!v2states.has(key)) v2states.set(key, { agentToken: 'tok-1', lastReadThroughSeq: 7 });
      return v2states.get(key);
    },
    mergeBlocks: (s) => s,
    withSlangContext: (s) => s,
    resolveMediaList: async (media) => {
      rec.resolvedMedia.push(media);
      return media.map((m) => ({ type: 'image', url: `img:${m}` }));
    },
    isCurrentSession: () => true,
    submitPromptWithTurnSlot: async (args) => {
      rec.submits.push(args);
      return { result: { ok: true, value: { command: { text: '好的' } } } };
    },
    turnDispatch: { isActive: () => false },
    shouldAuditKey: () => false,
    SENSITIVE_RE: /敏感/,
    sendNotice: async (key, text) => rec.notices.push({ key, text }),
    canonicalV2Key: (k) => k,
    noteModelMessagesV2: (st, msgs) => rec.noted.push({ st, msgs }),
    auditAndSend: async (key, text) => rec.audited.push({ key, text }),
    mdToPlain: (s) => `PLAIN(${s})`,
  };
  const merged = { ...ctx, ...overrides };
  return {
    core: createSocialCore(merged), merged, rec, social, socialV2,
    promptQueues, queued, pendingWakeKeys, messageMediaStore, v2states,
  };
}

function setTimer(recMap, key) {
  const timer = setTimeout(() => {}, 60_000);
  timer.unref?.();
  const set = recMap.get(key) ?? new Set();
  set.add(timer);
  recMap.set(key, set);
  return timer;
}

test('isSocialEnabled：只有 reserved 模式且配置未关时才开', () => {
  assert.equal(makeCtx().core.isSocialEnabled(), true, '默认开启');
  assert.equal(makeCtx({ cfg: { social: { enabled: false } } }).core.isSocialEnabled(), false, '配置关闭');
  assert.equal(makeCtx({ getCurrentMode: () => 'normal' }).core.isSocialEnabled(), false, '非 reserved 模式');
  assert.equal(makeCtx({ getCurrentMode: () => 'reserved2' }).core.isSocialEnabled(), false, 'reserved2 不算社交模式');
});

test('socialState：惰性创建完整默认状态，再次取用是同一个对象', () => {
  const { core, social } = makeCtx();
  assert.equal(social.states.has('group:1'), false);
  const st = core.socialState('group:1');
  assert.deepEqual(st, {
    phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0,
    activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0,
    lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0,
  });
  st.phase = 'active';
  assert.equal(core.socialState('group:1'), st, '复用同一对象，不重置');
  assert.equal(social.states.get('group:1').phase, 'active');
});

test('isDirectAddress：私聊一律算点名；群里只认 @/昵称/必回词/冲她提问', () => {
  const { core } = makeCtx({ cfg: { social: { mustReplyKeywords: ['在吗'] } } });
  assert.equal(core.isDirectAddress('随便什么', {}, 'private'), true, '私聊直接算');
  assert.equal(core.isDirectAddress('随便什么', {}, undefined), true, '非群聊直接算');
  assert.equal(core.isDirectAddress('今天吃啥', { kind: 'group' }, 'group'), false, '普通群聊');
  assert.equal(core.isDirectAddress('@12345 你看', { kind: 'group', self_id: 12345 }, 'group'), true, '硬件 @ self_id');
  assert.equal(core.isDirectAddress('@满满 早', { kind: 'group' }, 'group'), true, '@ 昵称');
  assert.equal(core.isDirectAddress('满满今天不在', { kind: 'group' }, 'group'), true, '提到昵称');
  assert.equal(core.isDirectAddress('在吗在吗', { kind: 'group' }, 'group'), true, '必回关键词');
  assert.equal(core.isDirectAddress('你是不是在糊弄我', { kind: 'group' }, 'group'), true, '直接针对她的提问');
  assert.equal(core.isDirectAddress(null, { kind: 'group' }, 'group'), false, '空文本不误判');
  assert.equal(core.isDirectAddress(12345, { kind: 'group' }, 'group'), false, '非字符串不炸');
});

test('isMustReplyText：不看 event 的“必须回”判定', () => {
  const { core } = makeCtx({ cfg: { social: { mustReplyKeywords: ['速回'] } } });
  assert.equal(core.isMustReplyText('@满满 来'), true);
  assert.equal(core.isMustReplyText('满满你人呢'), true, '昵称命中');
  assert.equal(core.isMustReplyText('速回一下'), true, '关键词命中');
  assert.equal(core.isMustReplyText('你在干嘛呢'), true, '直接针对');
  assert.equal(core.isMustReplyText('今天天气不错'), false);
  assert.equal(core.isMustReplyText(undefined), false, '非字符串不炸');
});

test('isDirectedAtAi：委托给纯规则模块（不额外加戏）', () => {
  const { core } = makeCtx();
  assert.equal(core.isDirectedAtAi('你有deepseek一半强吗'), true);
  assert.equal(core.isDirectedAtAi('人呢'), true);
  assert.equal(core.isDirectedAtAi('今天吃了面'), false);
  assert.equal(core.isDirectedAtAi(''), false);
});

test('appendRecentMessage：字段归一化、200 字截断、默认上限 50 条裁最旧', () => {
  const { core, social } = makeCtx();
  core.appendRecentMessage('group:1', '阿离', 'x'.repeat(250), null, 1, 0, 'not-array', 42);
  const first = social.recentMessages.get('group:1')[0];
  assert.equal(first.text.length, 200, 'text 截断到 200');
  assert.equal(first.plain.length, 200, 'plain 回落 text 后同样截断');
  assert.equal(first.quoteTargetIsSelf, true);
  assert.equal(first.isOwner, false);
  assert.deepEqual(first.media, [], '非数组 media 归一为 []');
  assert.equal(first.hasMedia, false);
  assert.equal(first.messageId, '42', 'messageRef 转字符串');
  assert.equal(typeof first.time, 'number');
  assert.equal(core.buildContextBlock('group:1').includes('阿离：'), true);

  for (let i = 0; i < 60; i += 1) core.appendRecentMessage('group:1', '阿离', `第${i}条`);
  const arr = social.recentMessages.get('group:1');
  assert.equal(arr.length, 50, '默认上下文 15 条 → 上限 max(50, 30)');
  assert.equal(arr[arr.length - 1].text, '第59条');
  assert.equal(arr[0].text, '第10条', '裁掉的是最旧的');
});

test('appendRecentMessage：contextWindow 调大时上限跟着放宽', () => {
  const { core, social } = makeCtx({ cfg: { social: { contextWindow: 100 } } });
  for (let i = 0; i < 55; i += 1) core.appendRecentMessage('group:2', 'a', `m${i}`);
  assert.equal(social.recentMessages.get('group:2').length, 55, '上限 200，55 条不裁');
});

test('appendSummary：结构带 since，items 上限 60 条', () => {
  const { core, social } = makeCtx();
  core.appendSummary('group:1', '阿离', '她说', null, true, ['https://img/1'], 'mid-1');
  const entry = social.pendingSummaries.get('group:1');
  assert.equal(typeof entry.since, 'number');
  assert.deepEqual(entry.items[0], {
    sender: '阿离', text: '她说', plain: '她说', isOwner: true,
    media: ['https://img/1'], messageId: 'mid-1', hasMedia: true, time: entry.items[0].time,
  });
  for (let i = 0; i < 61; i += 1) core.appendSummary('group:1', 'a', `t${i}`);
  assert.equal(entry.items.length, 60);
  assert.equal(entry.items[entry.items.length - 1].text, 't60');
  assert.equal(entry.items[0].text, 't1');
});

test('buildContextBlock：空会话给（无），按 contextWindow 取最近，带主人与媒体标记', () => {
  const { core } = makeCtx({ cfg: { social: { contextWindow: 2 } } });
  assert.equal(core.buildContextBlock('group:empty'), '（无）');

  core.appendRecentMessage('group:1', '阿离', '早', null, false, false, [], 'm1');
  core.appendRecentMessage('group:1', '他', '在', null, false, true, [], 'm2');
  core.appendRecentMessage('group:1', '阿离', '看图', null, false, false, ['https://img/a.jpg'], 'm3');
  const block = core.buildContextBlock('group:1');
  const lines = block.split('\n');
  assert.equal(lines.length, 2, '只取 contextWindow=2 条');
  assert.equal(lines[0], '【他】他：在', 'owner 加【他】');
  assert.equal(lines[1], '阿离：看图[媒体×1]', '媒体提示接在行尾');
});

test('enterActive：群聊抽一个活跃时长，私聊/关闭时不留退场时限', () => {
  const { core, social } = makeCtx();
  const before = Date.now();
  core.enterActive('group:1');
  const g = social.states.get('group:1');
  assert.equal(g.phase, 'active');
  assert.ok(g.lastCheckAt >= before);
  assert.equal(g.nextCheckAt, g.lastCheckAt + 20000, 'nextCheckAt 用 activeCheckMinMs');
  assert.equal(g.lastActiveMessageAt, g.lastCheckAt);
  assert.equal(g.activeEnteredAt, g.lastCheckAt);
  assert.equal(g.probeDeadline, 0);
  assert.equal(g.activeExitAt, 0);
  assert.equal(g.activeDeadlineAt, g.lastCheckAt + 15 * 60 * 1000, '群聊默认 15~30 分钟，桩 randInt 取 min');

  core.enterActive('private:1');
  assert.equal(social.states.get('private:1').activeDeadlineAt, 0, '私聊不自动退场');

  const h = makeCtx({ cfg: { social: { activeDurationEnabled: false } } });
  h.core.enterActive('group:9');
  assert.equal(h.social.states.get('group:9').activeDeadlineAt, 0, '关闭活跃时长后不设 deadline');
});

test('cancelSocialTimers / cancelAllSocialTimers：按 key 清理，不误伤别的群', () => {
  const { core, social } = makeCtx();
  setTimer(social.pendingTimers, 'group:1');
  setTimer(social.pendingTimers, 'group:1');
  setTimer(social.pendingTimers, 'group:2');
  assert.equal(social.pendingTimers.get('group:1').size, 2);

  core.cancelSocialTimers('group:1');
  assert.equal(social.pendingTimers.has('group:1'), false);
  assert.equal(social.pendingTimers.has('group:2'), true, '别的群不动');

  core.cancelSocialTimers('group:never');
  assert.equal(social.pendingTimers.has('group:2'), true, '没有定时器时静默返回');

  core.cancelAllSocialTimers();
  assert.equal(social.pendingTimers.size, 0);
});

test('leaveActive：清掉该群状态与静默上下文', () => {
  const { core, social } = makeCtx();
  core.enterActive('group:1');
  social.silentContext.set('group:1', [{ sender: 'a', text: 'x' }]);
  social.silentContext.set('group:2', [{ sender: 'b', text: 'y' }]);
  setTimer(social.pendingTimers, 'group:1');

  core.leaveActive('group:1');
  assert.equal(social.states.has('group:1'), false);
  assert.equal(social.silentContext.has('group:1'), false);
  assert.equal(social.pendingTimers.has('group:1'), false);
  assert.equal(social.states.has('group:2'), false, '状态本来就没有');
  assert.equal(social.silentContext.has('group:2'), true, '别的群静默上下文保留');
});

test('cleanupSocialForModeChange：全清并拒绝仍在排队的投递（避免 await 永久挂起）', () => {
  const { core, social, messageMediaStore, promptQueues, rec } = makeCtx();
  core.enterActive('group:1');
  social.recentMessages.set('group:1', [{ sender: 'a', text: 'x' }]);
  social.pendingSummaries.set('group:1', { items: [{ sender: 'a', text: 'x' }], since: 1 });
  social.silentContext.set('group:1', [{ sender: 'a', text: 'x' }]);
  social.silentTurns.set('sid:1', [{ id: 's1' }]);
  social.exitingSessions.add('sid:1');
  messageMediaStore.set('m1', ['x']);
  setTimer(social.pendingTimers, 'group:1');

  const rejections = [];
  promptQueues.set('group:1', {
    queue: [
      { promptText: 'A', opts: {}, resolve: () => {}, reject: (e) => rejections.push(e) },
      { promptText: 'B', opts: {}, resolve: () => {}, reject: (e) => rejections.push(e) },
    ],
    running: true,
  });

  core.cleanupSocialForModeChange();
  assert.equal(social.pendingTimers.size, 0);
  assert.equal(social.states.size, 0);
  assert.equal(social.recentMessages.size, 0);
  assert.equal(social.pendingSummaries.size, 0);
  assert.equal(social.silentContext.size, 0);
  assert.equal(social.silentTurns.size, 0);
  assert.equal(social.exitingSessions.size, 0);
  assert.equal(messageMediaStore.size, 0);
  assert.equal(promptQueues.size, 0);
  assert.equal(rejections.length, 2);
  assert.match(rejections[0].message, /模式切换，已取消排队中的投递/);
  assert.equal(rec.logs.length, 0, '清理不依赖日志');
});

test('buildBatchPrompt：必须回不提供 [SILENT]，可选回才给出口；引用消息带方向提示', () => {
  const { core } = makeCtx();
  const msgs = [
    { sender: '阿离', text: '看图', isOwner: false, messageId: 'm1', media: ['https://img/a.jpg'] },
    { sender: '他', text: '[引用 阿离：早]@满满 你说呢', isOwner: true, messageId: 'm2', media: [] },
  ];
  const must = core.buildBatchPrompt('group:1', msgs, false);
  assert.ok(must.startsWith('[LIFE] 晚上好\n\n'), '生活前缀在最前');
  assert.ok(must.includes('【新消息】'));
  assert.ok(must.includes('【他】他：[引用 阿离：早]@满满 你说呢'), 'owner 前缀保留');
  assert.ok(must.includes('阿离：看图[媒体×1]'));
  assert.ok(must.includes('[方向指引]'), '含 [引用 时给方向提示');
  assert.ok(must.includes('请回复消息。'));
  assert.ok(!must.includes('[SILENT]'), '必须回没有沉默出口');
  assert.ok(must.includes('[分段]'));

  const optional = core.buildBatchPrompt('group:1', [{ sender: 'a', text: '闲聊', isOwner: false, media: [] }]);
  assert.ok(optional.includes('请根据情况决定是否回复'));
  assert.ok(optional.includes('[SILENT]'));
  assert.ok(!optional.includes('[方向指引]'), '没有引用就不加方向提示');

  const empty = core.buildBatchPrompt('group:1', []);
  assert.ok(empty.includes('【新消息】'), '空批次仍给出可识别的骨架');
});

test('buildBatchPrompt：惦记的事有内容时才加 [RUMINATE] 前缀', () => {
  const { core } = makeCtx({ ruminationPre: () => '[RUMINATE] 还在想那个视频' });
  const p = core.buildBatchPrompt('group:1', [{ sender: 'a', text: 'hi', isOwner: false, media: [] }]);
  assert.ok(p.startsWith('[LIFE] 晚上好\n\n[RUMINATE] 还在想那个视频\n\n'), `实际开头：${p.slice(0, 40)}`);
});

test('buildProbePrompt：带上群聊上下文与 [SILENT] 出口', () => {
  const { core } = makeCtx();
  core.appendRecentMessage('group:1', '阿离', '安静了', null, false, false, [], 'm1');
  const p = core.buildProbePrompt('group:1');
  assert.ok(p.startsWith('[LIFE] 晚上好\n\n'), '生活前缀');
  assert.ok(p.includes('【群聊上下文】\n阿离：安静了'));
  assert.ok(p.includes('群里安静了一会儿'));
  assert.ok(p.includes('[SILENT]'));
});

test('buildActiveExitPrompt：角色提示可选，正文含上下文与收尾指引', () => {
  const { core } = makeCtx();
  assert.equal(core.buildActiveExitPrompt('group:1', '').startsWith('【群聊上下文】'), true, '无角色提示不留空行');
  const p = core.buildActiveExitPrompt('group:1', '【角色】你是群友');
  assert.ok(p.startsWith('【角色】你是群友\n\n'));
  assert.ok(p.includes('你已经参与群聊有一阵子了'));
  assert.ok(p.includes('（无）'), '空上下文回落');
});

test('buildProactivePrompt：角色/生活/上下文齐备，带 [SILENT]', () => {
  const { core } = makeCtx();
  core.appendRecentMessage('group:1', '阿离', '睡了', null, false, false, [], 'm1');
  const p = core.buildProactivePrompt('group:1', '【角色】你是群友');
  assert.ok(p.startsWith('【角色】你是群友\n\n'));
  assert.ok(p.includes('[LIFE] 晚上好\n\n'));
  assert.ok(p.includes('【群聊上下文】\n阿离：睡了'));
  assert.ok(p.includes('开启一个新话题'));
  assert.ok(p.includes('[SILENT]'));
});

test('triggerActiveDurationExit：非群聊/关闭/未到点/非 active 都不触发', () => {
  const h = makeCtx();
  const st = h.core.socialState('group:1');
  assert.equal(h.core.triggerActiveDurationExit('group:1', null, Date.now()), false, '没有状态');
  st.phase = 'active';
  assert.equal(h.core.triggerActiveDurationExit('private:1', st, Date.now()), false, '私聊不自动退场');

  h.core.enterActive('group:1');
  const live = h.social.states.get('group:1');
  assert.equal(h.core.triggerActiveDurationExit('group:1', live, live.activeDeadlineAt - 1), false, '差 1ms 不触发');
  live.activeDeadlineAt = 0;
  assert.equal(h.core.triggerActiveDurationExit('group:1', live, Date.now()), false, '没有 deadline 不触发');

  const off = makeCtx({ cfg: { social: { activeDurationEnabled: false } } });
  off.core.enterActive('group:1');
  const st2 = off.social.states.get('group:1');
  st2.activeDeadlineAt = 1;
  assert.equal(off.core.triggerActiveDurationExit('group:1', st2, Date.now()), false, '开关关闭不触发');
  assert.equal(st2.phase, 'active');
});

test('triggerActiveDurationExit：到点切 exiting、取消旧定时器并安排退场投递', () => {
  const h = makeCtx();
  h.core.enterActive('group:1');
  const st = h.social.states.get('group:1');
  setTimer(h.social.pendingTimers, 'group:1');
  const now = st.activeDeadlineAt;

  assert.equal(h.core.triggerActiveDurationExit('group:1', st, now), true);
  assert.equal(st.phase, 'exiting');
  assert.equal(st.activeExitAt, now);
  assert.equal(h.social.pendingTimers.has('group:1'), false, '退场前取消旧定时器');
  assert.equal(h.rec.scheduled.length, 1);
  const call = h.rec.scheduled[0];
  assert.equal(call.key, 'group:1');
  assert.equal(call.label, '活跃超时退场');
  assert.equal(call.farewell, true);
  assert.equal(call.min, 2000);
  assert.equal(call.max, 8000);
  assert.ok(call.text.startsWith('【角色】\n\n'), '角色提示来自 currentRoleHint');
  assert.ok(call.text.includes('该自然地收尾/潜水了'));
  assert.ok(h.rec.logs.some((l) => l.includes('活跃超过时长上限')));

  // 第二次：phase 已是 exiting，首个 guard 直接 false；不会重复安排退场
  assert.equal(h.core.triggerActiveDurationExit('group:1', st, now + 1), false);
  assert.equal(h.rec.scheduled.length, 1);
});

test('deliverPromptNow：当前模式不允许该会话时直接抛错，不建会话', async () => {
  const h = makeCtx({ isSessionAllowedInCurrentMode: (key) => key !== 'group:1' });
  await assert.rejects(h.core.deliverPromptNow('group:1', 'A'), /当前模式不允许会话 group:1/);
  assert.equal(h.rec.ensured.length, 0);
  assert.equal(h.rec.submits.length, 0);
});

test('deliverPromptNow：唤醒在暂停/非 reserved2/配置关闭时跳过并解绑租约', async () => {
  const h = makeCtx();
  h.pendingWakeKeys.add('group:1');
  const r1 = await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  assert.deepEqual(r1, { ok: true, skipped: true });
  assert.equal(h.pendingWakeKeys.has('group:1'), false);
  assert.deepEqual(h.rec.disarmed, ['group:1']);
  assert.equal(h.rec.ensured.length, 0, '跳过时连会话都不建');

  const paused = makeCtx({ getCurrentMode: () => 'reserved2', socialV2: { paused: true, conversations: new Map() } });
  paused.pendingWakeKeys.add('group:1');
  assert.deepEqual(await paused.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' }), { ok: true, skipped: true });

  const disabled = makeCtx({ getCurrentMode: () => 'reserved2', cfg: { socialV2: { enabled: false } } });
  assert.deepEqual(await disabled.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' }), { ok: true, skipped: true });
});

test('deliverPromptNow：DSH 未就绪时入队，超限丢最旧并记日志', async () => {
  const h = makeCtx({ getDshReady: () => false, getCurrentMode: () => 'reserved2' });
  for (const p of ['p1', 'p2', 'p3']) {
    assert.deepEqual(await h.core.deliverPromptNow('group:1', p), { ok: true, queued: true });
  }
  assert.deepEqual(h.queued.get('group:1').map((i) => i.promptText), ['p1', 'p2', 'p3']);
  assert.deepEqual(await h.core.deliverPromptNow('group:1', 'p4', { farewell: true, silent: true, wakeReason: 'x' }), { ok: true, queued: true });
  const items = h.queued.get('group:1');
  assert.deepEqual(items.map((i) => i.promptText), ['p2', 'p3', 'p4'], '满了丢最旧');
  assert.deepEqual(items[2], { promptText: 'p4', farewell: true, silent: true, media: [], wakeReason: 'x' });
  assert.ok(h.rec.logs.some((l) => l.includes('队列满（3）')));
  assert.equal(h.rec.ensured.length, 0);
});

test('deliverPromptNow：会话创建期间重置 → 转重试队列；其他错误原样抛', async () => {
  const reset = makeCtx({ ensureSession: async () => { throw new Error('会话创建期间已重置'); } });
  assert.deepEqual(await reset.core.deliverPromptNow('group:1', 'A', { silent: true }), { ok: true, retried: true });
  assert.equal(reset.rec.retried.length, 1);
  assert.deepEqual(reset.rec.retried[0], { key: 'group:1', promptText: 'A', opts: { silent: true } });
  assert.equal(reset.rec.submits.length, 0);

  const boom = makeCtx({ ensureSession: async () => { throw new Error('boom'); } });
  await assert.rejects(boom.core.deliverPromptNow('group:1', 'A'), /boom/);
  assert.equal(boom.rec.retried.length, 0);
});

test('deliverPromptNow：成功投递走串行槽位，并把回复转纯文本发出去', async () => {
  const h = makeCtx();
  assert.deepEqual(await h.core.deliverPromptNow('group:1', '正文'), { ok: true });
  assert.deepEqual(h.rec.ensured, ['group:1']);
  assert.equal(h.rec.submits.length, 1);
  const args = h.rec.submits[0];
  assert.equal(args.sessionId, 'sid:group:1');
  assert.equal(args.label, 'group:1');
  assert.equal(args.kind, 'chat');
  assert.equal(args.useSlot, true, '无活跃回合时用 turn slot');
  assert.deepEqual(args.content, [{ type: 'text', text: '正文' }]);
  assert.deepEqual(h.rec.audited, [{ key: 'group:1', text: 'PLAIN(好的)' }]);
  assert.equal(h.social.exitingSessions.size, 0);
});

test('deliverPromptNow：已有活跃回合时不占 turn slot', async () => {
  const h = makeCtx({ turnDispatch: { isActive: () => true } });
  await h.core.deliverPromptNow('group:1', 'A');
  assert.equal(h.rec.submits[0].useSlot, false, '活跃回合里不抢 slot');
});

test('deliverPromptNow：opts.media 解析成图片内容块；无 media 不碰 resolveMediaList', async () => {
  const h = makeCtx();
  await h.core.deliverPromptNow('group:1', '看图', { media: ['u1', 'u2'] });
  assert.deepEqual(h.rec.resolvedMedia, [['u1', 'u2']]);
  assert.equal(h.rec.submits[0].content.length, 3);
  assert.deepEqual(h.rec.submits[0].content[1], { type: 'image', url: 'img:u1' });
  assert.equal(h.rec.submits[0].content[0].text, '看图');

  const plain = makeCtx();
  await plain.core.deliverPromptNow('group:1', '没图', { media: [] });
  assert.equal(plain.rec.resolvedMedia.length, 0);
});

test('deliverPromptNow：回复被拒时返回错误、脱敏后告警，并撤掉退场标记', async () => {
  const h = makeCtx({
    shouldAuditKey: () => true,
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 400, message: '敏感内容' } } }),
  });
  const r = await h.core.deliverPromptNow('group:1', 'A', { farewell: true });
  assert.deepEqual(r, { ok: false, error: '（含敏感信息，已隐藏）' });
  assert.deepEqual(h.rec.notices, [{ key: 'group:1', text: '⚠️ 消息未被接受：（含敏感信息，已隐藏）' }]);
  assert.equal(h.social.exitingSessions.size, 0, '被拒不能留下退场标记');
  assert.equal(h.rec.audited.length, 0);

  const bulk = makeCtx({
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 500, message: '服务端炸了' } } }),
  });
  assert.deepEqual(await bulk.core.deliverPromptNow('group:1', 'A'), { ok: false, error: '500: 服务端炸了' });
  assert.equal(bulk.rec.notices[0].text, '⚠️ 消息未被接受：500: 服务端炸了');

  const silent = makeCtx({
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 500, message: 'x' } } }),
  });
  assert.deepEqual(await silent.core.deliverPromptNow('group:1', 'A', { silent: true }), { ok: false, error: '500: x' });
  assert.equal(silent.rec.notices.length, 0, 'silent 不回告警');
});

test('deliverPromptNow：投递前会话被重置 → 抛错且不提交', async () => {
  const h = makeCtx({ isCurrentSession: () => false });
  await assert.rejects(h.core.deliverPromptNow('group:1', 'A'), /投递前会话已重置或权限已变化/);
  assert.equal(h.rec.submits.length, 0);
});

test('deliverPromptNow：命令里没有文本时只算投递成功，不发 QQ 消息', async () => {
  const h = makeCtx({
    submitPromptWithTurnSlot: async () => ({ result: { ok: true, value: { command: {} } } }),
  });
  assert.deepEqual(await h.core.deliverPromptNow('group:1', 'A'), { ok: true });
  assert.equal(h.rec.audited.length, 0);
});

test('deliverPromptNow：silent+farewell 有文本时撤掉退场标记但不发消息', async () => {
  const h = makeCtx();
  await h.core.deliverPromptNow('group:1', 'A', { silent: true, farewell: true });
  assert.equal(h.rec.audited.length, 0);
  assert.equal(h.social.exitingSessions.size, 0);
});

test('deliverPromptNow：reserved2 下的唤醒不往 QQ 发命令文本', async () => {
  const h = makeCtx({ getCurrentMode: () => 'reserved2' });
  await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  assert.equal(h.rec.audited.length, 0, 'reserved2 只投给模型，不回群');
});

test('deliverPromptNow：owner lane 只对唤醒生效，普通投递仍走主会话', async () => {
  const h = makeCtx({ ownerLaneFor: (key) => key === 'group:1', getCurrentMode: () => 'reserved2' });
  await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  assert.deepEqual(h.rec.ensured, ['group:1#owner']);

  const normal = makeCtx({ ownerLaneFor: (key) => key === 'group:1' });
  await normal.core.deliverPromptNow('group:1', 'A');
  assert.deepEqual(normal.rec.ensured, ['group:1']);
});

test('deliverPromptNow：唤醒拼装注入层/自由三行/快照与水位，被接受后才推进 lastPromptSeq', async () => {
  // 快照回写要求「会话仍指向同一个 v2 状态对象」：这里模拟生产里的 socialV2.conversations
  const v2state = { agentToken: 'tok-1', lastReadThroughSeq: 7 };
  const h = makeCtx({
    getCurrentMode: () => 'reserved2',
    socialV2: { paused: false, conversations: new Map([['group:1', v2state]]) },
    getSocialV2State: () => v2state,
    buildWakeSnapshotV2: () => ({
      text: 'SNAP-TEXT', readThroughSeq: 42, partial: true,
      unreadCount: 10, includedUnreadCount: 4, omitted: 6,
      trigger: { id: 9 }, messages: [{ id: 1 }, { id: 2 }], recent: [{ id: 3 }], readContext: true,
    }),
  });

  const r = await h.core.deliverPromptNow('group:1', '旧文本', { wakeReason: 'unread', wakeInjections: '[INJ] ' });
  assert.deepEqual(r, { ok: true });
  const text = h.rec.submits[0].content[0].text;
  assert.ok(text.includes('WAKE[group:1][unread]'));
  assert.ok(text.includes('[INJ] WAKE'), '注入层在基底前面');
  assert.ok(text.includes('[FREEDOM]') && text.includes('[AGENCY]') && text.includes('[PRAGMA]'));
  assert.ok(text.includes('SNAP-TEXT'));
  assert.ok(text.includes('未读共 10 条，这次带了 4 条') && text.includes('还有 6 条没展开'));
  assert.ok(text.includes('叫醒你的那条已单独放在 trigger'));
  assert.ok(text.includes('recent 是已读旧话'));
  assert.ok(text.includes('直接传这个数：42'));
  assert.equal(h.rec.recorded.length, 1, '自由策略落盘');
  assert.equal(h.rec.noted.length, 1);
  assert.deepEqual(h.rec.noted[0].msgs, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(v2state.agentToken, 'tok-1');
  assert.equal(v2state.lastPromptSeq, 42, '被接受后才把「已展示水位」写进状态');
  assert.ok(h.rec.logs.includes('【自由日志】'));
});

test('deliverPromptNow：快照为 null 时退回会话已展示水位；非 partial 不提示未读截断', async () => {
  const h = makeCtx({
    getCurrentMode: () => 'reserved2',
    buildWakeSnapshotV2: () => ({
      text: '', readThroughSeq: 0, partial: false, readContext: false, messages: [], recent: [],
    }),
  });
  await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  const text = h.rec.submits[0].content[0].text;
  assert.ok(!text.includes('未读没带完'));
  assert.ok(!text.includes('recent 是已读旧话'));
  assert.ok(text.includes('直接传这个数：0'));

  const h2 = makeCtx({ getCurrentMode: () => 'reserved2' });
  await h2.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  const text2 = h2.rec.submits[0].content[0].text;
  assert.ok(!text2.includes('【本次消息快照】'), '没快照就不贴快照段');
  assert.equal(h2.v2states.get('group:1').lastPromptSeq, 7, '没快照就用会话已展示水位');
});

test('deliverPromptNow：会话已被替换/令牌轮换时不回写快照与水位', async () => {
  const v2state = { agentToken: 'tok-2', lastReadThroughSeq: 7 };
  const h = makeCtx({
    getCurrentMode: () => 'reserved2',
    ownerLaneFor: (key) => key === 'group:1',
    socialV2: { paused: false, conversations: new Map([['group:1', v2state]]) },
    getSocialV2State: () => v2state,
    isCurrentSession: () => true,
    // 投递期间令牌轮换：投递前的 wakeToken 已失效，不应把「已展示」/水位写回旧会话。
    submitPromptWithTurnSlot: async (args) => {
      h.rec.submits.push(args);
      v2state.agentToken = 'tok-rotated';
      return { result: { ok: true, value: { command: { text: '好的' } } } };
    },
    buildWakeSnapshotV2: () => ({
      text: '', readThroughSeq: 42, partial: false, readContext: false, messages: [{ id: 1 }], recent: [],
    }),
  });
  assert.deepEqual(await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' }), { ok: true });
  assert.equal(h.rec.noted.length, 0, '令牌轮换后不回写「已展示」');
  assert.equal(v2state.lastPromptSeq, undefined, '水位不能低报到旧会话');
});

test('deliverPromptNow：owner lane 用 laneKey 校验，正常轮换不误挡水位回写', async () => {
  const v2state = { agentToken: 'tok-2', lastReadThroughSeq: 7 };
  const h = makeCtx({
    getCurrentMode: () => 'reserved2',
    ownerLaneFor: (key) => key === 'group:1',
    socialV2: { paused: false, conversations: new Map([['group:1', v2state]]) },
    getSocialV2State: () => v2state,
    // [OWNER-LANE-FIX] sessionId 属于 lane；若按主 key 校验会话，owner lane 恒判 false、水位永不推进。
    isCurrentSession: (k) => k === 'group:1#owner',
    buildWakeSnapshotV2: () => ({
      text: '', readThroughSeq: 42, partial: false, readContext: false, messages: [{ id: 1 }], recent: [],
    }),
  });
  assert.deepEqual(await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' }), { ok: true });
  assert.equal(h.rec.noted.length, 1, 'lane 会话有效时应回写「已展示」');
  assert.equal(v2state.lastPromptSeq, 42, 'owner lane 水位应正常推进');
});

test('deliverPromptNow：自由策略/合并块抛错时 best-effort 继续投递', async () => {
  const h = makeCtx({
    getCurrentMode: () => 'reserved2',
    mergeBlocks: () => { throw new Error('merge 炸了'); },
    buildFreedomPolicy: () => { throw new Error('policy 炸了'); },
  });
  const r = await h.core.deliverPromptNow('group:1', 'A', { wakeReason: 'unread' });
  assert.deepEqual(r, { ok: true });
  assert.equal(h.rec.recorded.length, 0);
  const text = h.rec.submits[0].content[0].text;
  assert.ok(text.includes('WAKE[group:1][unread]'));
  assert.ok(!text.includes('[FREEDOM]'));
});

test('deliverPrompt：同一会话严格串行，前一条完成前不提交下一条', async () => {
  let release;
  const order = [];
  const h = makeCtx({
    submitPromptWithTurnSlot: async (args) => {
      order.push(args.content[0].text);
      if (order.length === 1) await new Promise((r) => { release = r; });
      return { result: { ok: true, value: { command: { text: `回${order.length}` } } } };
    },
  });

  const p1 = h.core.deliverPrompt('group:1', 'A');
  const p2 = h.core.deliverPrompt('group:1', 'B');
  await tickAsync();
  assert.deepEqual(order, ['A'], '第二条必须等第一条');
  assert.equal(h.promptQueues.get('group:1').queue.length, 1);

  release();
  assert.deepEqual(await p1, { ok: true });
  await tickAsync();
  assert.deepEqual(order, ['A', 'B']);
  assert.deepEqual(await p2, { ok: true });
  assert.deepEqual(order, ['A', 'B']);
  assert.equal(h.promptQueues.has('group:1'), false, '队列跑空后删除');
});

test('deliverPrompt：前一条失败会 reject 调用方，但不阻塞后续', async () => {
  let n = 0;
  const h = makeCtx({
    ensureSession: async (key) => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return `sid:${key}`;
    },
  });
  const p1 = h.core.deliverPrompt('group:1', 'A');
  const p2 = h.core.deliverPrompt('group:1', 'B');
  await assert.rejects(p1, /boom/);
  assert.deepEqual(await p2, { ok: true });
  assert.equal(h.promptQueues.has('group:1'), false);
});
