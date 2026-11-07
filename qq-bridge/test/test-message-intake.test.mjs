// message-intake 金标：入站消息的判定/归一化/去重/状态迁移/错误分支。
//
// 本模块是「什么时候叫她、等多久、什么时候重试」的决策层，依赖全部由 app.mjs 注入。
// 这里用桩列出每一份依赖（见 makeHarness 的 deps 对象，按模块 destructure 顺序分组），
// 只断言本模块自己的决策与状态变化，不测下游实现（发送队列/DSH/OneBot/群成员查询）。
//
// 确定性：不联网、不起服务；唯一的全局钩子是 ASR 分支用的 globalThis.fetch（该分支
// 直接调全局 fetch，不是注入的），测试里临时替换并用 t.after 还原。
// 需要文件系统的地方只有 ROOT/roles/*.md，全部落在 os.tmpdir() 的 mkdtemp 目录（文件级 after 清理）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessageIntake } from '../src/domain/conversation/message-intake.mjs';

const OWNER = '1001';
const SELF = '9999';
const GROUP = '555';

// 只用于 ROOT/roles/*.md 这类需要真实文件系统的判断；全部落在 os.tmpdir()，跑完统一删。
const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function privateEvent(over = {}) {
  return {
    user_id: OWNER,
    self_id: SELF,
    message_id: 'm1',
    message_seq: 11,
    sender: { nickname: '主人' },
    message: [{ type: 'text', data: { text: 'hi' } }],
    ...over,
  };
}

function groupEvent(over = {}) {
  return {
    user_id: '2002',
    self_id: SELF,
    group_id: GROUP,
    message_id: 'g1',
    message_seq: 21,
    sender: { card: '群友A', nickname: 'nickA' },
    message: [{ type: 'text', data: { text: 'hello' } }],
    ...over,
  };
}

function makeV2State(over = {}) {
  return {
    recentMessages: [],
    bootstrapSent: false,
    lastUnreadSeq: 7,
    lastAboutSelf: null,
    lastEmotionGuess: null,
    emotionCalibration: null,
    discourse: null,
    lastPragmaticFrame: null,
    ...over,
  };
}

function makeHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-intake-'));
  TEMP_DIRS.push(root);
  const calls = {};
  const rec = (name, impl) => (...args) => {
    (calls[name] ??= []).push(args);
    return impl ? impl(...args) : undefined;
  };

  const v2states = new Map();
  const getV2 = (key) => {
    if (!v2states.has(key)) v2states.set(key, makeV2State());
    return v2states.get(key);
  };
  const socialStateMap = new Map();
  const socialState = (key) => {
    if (!socialStateMap.has(key)) socialStateMap.set(key, { phase: 'idle' });
    return socialStateMap.get(key);
  };

  const st = {
    root,
    roleState: { mode: 'active', role: null },
    state: { sessions: {}, sessionPolicies: {} },
    social: {
      silentTurns: new Set(),
      exitingSessions: new Set(),
      recentMessages: new Map(),
      pendingSummaries: new Map(),
      states: socialStateMap,
      silentContext: new Map(),
    },
    socialV2: { paused: false, conversations: new Map() },
    collectors: new Map(),
    reverse: new Map(),
    modelAppliedSessions: new Set(),
    sendToolSucceededSessions: new Set(),
    pendingSendToolCalls: new Map(),
    v2TurnStartAt: new Map(),
    toolCallNames: new Map(),
    pending: new Map(),
    queued: new Map(),
    queuedHintAt: new Map(),
    messageMediaStore: new Map(),
    sessionPromises: new Map(),
    slangWindows: new Map(),
    slangExtractionCooldowns: new Map(),
    slangSubmitTimes: new Map(),
    pendingWakeKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    markReadCalledKeys: new Set(),
    wakeConfigMissCount: new Map(),
    seenForwardIds: new Set(),
    epoch: 0,
  };

  const cfg = { ownerQQ: OWNER, ackMessage: '', socialV2: {}, social: {} };

  // 依赖清单与 src/message-intake.mjs 的 destructure 一一对应（按用途分组注释）。
  const deps = {
    // 常量 / 路径
    DIRECTION_HINT: '[方向:这句是对她说的]',
    MAX_MEDIA_STORE_PER_KEY: 3,
    QUEUE_HINT_COOLDOWN_MS: 60_000,
    QUEUE_MAX: 2,
    ROOT: root,
    SENSITIVE_RE: /secret/i,
    SILENT_MARKER: '[沉默]',
    SPACE_SPLIT_HINT: '[分段]',
    // 名单 / 会话 / 模式
    allowed: rec('allowed', () => true),
    modeAllowed: rec('modeAllowed', () => true),
    convKey: rec('convKey', (kind, id) => `${kind}:${id}`),
    currentMode: 'active',
    getCurrentMode: () => 'active',
    getDshReady: () => true,
    dshReady: true,
    sessionEpoch: 0,
    // 会话与队列容器
    state: st.state,
    social: st.social,
    socialV2: st.socialV2,
    socialGraph: {},
    pending: st.pending,
    queued: st.queued,
    queuedHintAt: st.queuedHintAt,
    messageMediaStore: st.messageMediaStore,
    sessionPromises: st.sessionPromises,
    collectors: st.collectors,
    reverse: st.reverse,
    modelAppliedSessions: st.modelAppliedSessions,
    sendToolSucceededSessions: st.sendToolSucceededSessions,
    pendingSendToolCalls: st.pendingSendToolCalls,
    v2TurnStartAt: st.v2TurnStartAt,
    toolCallNames: st.toolCallNames,
    slangWindows: st.slangWindows,
    slangExtractionCooldowns: st.slangExtractionCooldowns,
    slangSubmitTimes: st.slangSubmitTimes,
    pendingWakeKeys: st.pendingWakeKeys,
    wakeConfigUpdatedKeys: st.wakeConfigUpdatedKeys,
    markReadCalledKeys: st.markReadCalledKeys,
    wakeConfigMissCount: st.wakeConfigMissCount,
    seenForwardIds: st.seenForwardIds,
    // 生活状态
    getLifeState: rec('getLifeState', () => null),
    lifeNote: rec('lifeNote'),
    touchLifeInterest: rec('touchLifeInterest'),
    markInterest: rec('markInterest'),
    saveLifeFile: rec('saveLifeFile'),
    // 消息解析
    segmentsToText: rec('segmentsToText', async (segs) => (Array.isArray(segs)
      ? segs.map((s) => (s && s.type === 'text' ? String(s.data?.text ?? '') : '')).join('')
      : '')),
    resolveGroupMemberName: rec('resolveGroupMemberName', async (gid, qq) => `NAME-${qq}`),
    resolveReplyInfo: rec('resolveReplyInfo', async () => null),
    isQuoteTargetSelf: rec('isQuoteTargetSelf', async () => false),
    isQuoteTargetOwner: rec('isQuoteTargetOwner', async () => false),
    extractForwardIds: rec('extractForwardIds', () => []),
    formatForwardResponse: rec('formatForwardResponse', () => ({ messages: [], total: 0, truncated: false })),
    extractMediaFromSegments: rec('extractMediaFromSegments', () => []),
    extractLinks: rec('extractLinks', () => []),
    mediaHintFor: rec('mediaHintFor', (key, ref, list) => (Array.isArray(list) && list.length ? `【附件:${list.length}】` : '')),
    resolveMediaList: rec('resolveMediaList', async (list) => list.map((m, i) => ({ type: 'image', data: { idx: i } }))),
    messageAtsSelf: rec('messageAtsSelf', () => false),
    cleanMemberName: rec('cleanMemberName', (s) => String(s ?? '').replace(/\[color[^\]]*\]/g, '')),
    firstReplyId: rec('firstReplyId', () => null),
    readPageForIntake: rec('readPageForIntake', async () => null),
    // 角色 / 社交状态
    readRoleState: rec('readRoleState', () => st.roleState),
    writeRoleState: rec('writeRoleState', (role, mode) => { st.roleState = { role, mode }; }),
    sanitizeRoleName: rec('sanitizeRoleName', (s) => String(s ?? '').trim()),
    currentRoleHint: rec('currentRoleHint', () => ''),
    getSocialV2State: getV2,
    saveSocialV2State: rec('saveSocialV2State'),
    saveState: rec('saveState'),
    saveSocialGraphSoon: rec('saveSocialGraphSoon'),
    socialState: rec('socialState', socialState),
    isSocialEnabled: rec('isSocialEnabled', () => false),
    isSessionAllowedInCurrentMode: rec('isSessionAllowedInCurrentMode', () => true),
    // 社交模式：活跃/退场/接话
    appendActivity: rec('appendActivity'),
    appendRecentMessage: rec('appendRecentMessage'),
    appendSocialV2Message: rec('appendSocialV2Message'),
    appendSummary: rec('appendSummary'),
    selfNickname: '小助手',
    bot: { raw: rec('botRaw', async () => []) },
    bumpSessionEpoch: rec('bumpSessionEpoch', () => { st.epoch += 1; }),
    cancelPendingEntry: rec('cancelPendingEntry', async () => {}),
    cancelSocialTimers: rec('cancelSocialTimers'),
    clearSocialV2Timers: rec('clearSocialV2Timers'),
    forgetAgentToken: rec('forgetAgentToken'),
    drainPromptQueue: rec('drainPromptQueue'),
    enterActive: rec('enterActive'),
    triggerActiveDurationExit: rec('triggerActiveDurationExit', () => false),
    scheduleSocialReply: rec('scheduleSocialReply'),
    scheduleWakeV2: rec('scheduleWakeV2'),
    buildContextBlock: rec('buildContextBlock', () => 'CTX-BLOCK'),
    maybeJoinOrContinue: rec('maybeJoinOrContinue'),
    isDirectAddress: rec('isDirectAddress', () => false),
    polarityOf: rec('polarityOf', () => 'neutral'),
    noteEdge: rec('noteEdge', () => true),
    noteCorrection: rec('noteCorrection'),
    feedSlangWindow: rec('feedSlangWindow'),
    recordStickerCandidate: rec('recordStickerCandidate'),
    seedCuriosityFromChat: rec('seedCuriosityFromChat'),
    evaluateWakeTriggerV2: rec('evaluateWakeTriggerV2', () => null),
    secretaryJudge: rec('secretaryJudge', async () => null),
    secretaryAllows: rec('secretaryAllows', (v) => !(v && v.should_reply === false)),
    // 语用 / 情绪
    classifyPragmaticFrame: rec('classifyPragmaticFrame', () => null),
    createDiscourseState: rec('createDiscourseState', () => ({ turns: [] })),
    updateDiscourseState: rec('updateDiscourseState', (s, frame) => ({ ...s, last: frame?.kind ?? null })),
    applyEmotionCalibration: rec('applyEmotionCalibration', (emotion) => emotion),
    detectEmotionCorrection: rec('detectEmotionCorrection', () => false),
    recordEmotionFeedback: rec('recordEmotionFeedback', (cal, fb) => ({ ...(cal ?? {}), feedbacks: [fb] })),
    // 发送 / DSH
    api: {
      stopSessionWork: rec('stopSessionWork', async () => {}),
      workspace: { archiveSession: rec('archiveSession', async () => {}) },
    },
    auditAndSend: rec('auditAndSend', async () => {}),
    sendToQQ: rec('sendToQQ', async () => {}),
    sendNotice: rec('sendNotice', async () => {}),
    mdToPlain: rec('mdToPlain', (t) => `plain:${t}`),
    handlePendingAnswer: rec('handlePendingAnswer', async () => {}),
    ensureSession: rec('ensureSession', async () => 'sess-1'),
    ensureChatModel: rec('ensureChatModel', async () => 'applied'),
    chatEffortFor: rec('chatEffortFor', () => 'high'),
    isCurrentSession: rec('isCurrentSession', () => true),
    enqueueForRetry: rec('enqueueForRetry'),
    deliverPrompt: rec('deliverPrompt', async () => {}),
    submitPromptWithTurnSlot: rec('submitPromptWithTurnSlot', async () => ({ result: { ok: true, value: {} } })),
    turnDispatch: { isActive: rec('turnIsActive', () => false) },
    shouldAuditKey: rec('shouldAuditKey', () => false),
    withSlangContext: rec('withSlangContext', (t) => t),
    log: rec('log'),
    fs,
    path,
  };

  const intake = createMessageIntake({ ...deps, ...overrides });

  return {
    intake,
    calls,
    st,
    root,
    cfg,
    deps,
    depKeys: Object.keys(deps),
    getV2,
    socialState,
    async call(kind = 'private', id = OWNER, event = privateEvent(), cfgOver = {}) {
      const merged = {
        ...cfg,
        ...cfgOver,
        socialV2: { ...(cfg.socialV2 ?? {}), ...(cfgOver.socialV2 ?? {}) },
        social: { ...(cfg.social ?? {}), ...(cfgOver.social ?? {}) },
      };
      await intake.handleIncoming(kind, id, event, merged);
      return merged;
    },
    submits() {
      return (calls.submitPromptWithTurnSlot ?? []).map(([req]) => req);
    },
    prompts() {
      return (calls.submitPromptWithTurnSlot ?? []).map(([req]) => req.content[0].text);
    },
    lastPrompt() {
      return this.prompts().at(-1);
    },
    logs() {
      return (calls.log ?? []).map(([m]) => String(m));
    },
  };
}

// 临时接管全局 fetch（ASR 分支用的是全局 fetch，不是注入依赖）。
function stubGlobalFetch(t, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = orig; });
}

// ── 接线契约 ────────────────────────────────────────────────────────────────

test('接线契约：桩覆盖 createMessageIntake 解构的每个依赖（漏注入会 ReferenceError）', () => {
  const src = fs.readFileSync(new URL('../src/domain/conversation/message-intake.mjs', import.meta.url), 'utf8');
  const block = /export function createMessageIntake\(deps\) \{\s*const \{([\s\S]*?)\} = deps;/.exec(src);
  assert.ok(block, '没找到 createMessageIntake 的依赖解构块，测试需要同步更新');
  const names = block[1].split(',')
    .map((s) => s.split(':')[0].trim()) // 兼容 `fetch: fetchImpl` 这种重命名解构
    .filter(Boolean);
  const h = makeHarness();
  const missing = names.filter((name) => !h.depKeys.includes(name));
  assert.deepEqual(missing, [], `测试桩缺少依赖：${missing.join('、')}（模块里用到就是 ReferenceError）`);
  assert.deepEqual(names, [...new Set(names)], '模块的依赖清单不应有重复项');
});

// ── 白名单 / 模式 / 生命状态 ────────────────────────────────────────────────

test('白名单外消息：只记一行日志就丢弃，不解析不投递', async () => {
  const h = makeHarness({ modeAllowed: () => false });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.logs().length, 1);
  assert.match(h.logs()[0], /\[allow\] 丢弃 private:1001（不在名单，来自 1001）—— 不进入后端/);
  assert.equal(h.calls.segmentsToText, undefined, '被拦截就不该解析消息');
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
  assert.equal(h.calls.sendToQQ, undefined);
  assert.equal(h.calls.touchLifeInterest.length, 1, '有人找她这件事仍然记一笔');
});

test('modeAllowed 拿到 convKey 的 key、kind/id 和「实时」模式（不是构造快照）', async () => {
  const seen = [];
  const h = makeHarness({
    modeAllowed: (key, kind, id, cfg, mode) => { seen.push({ key, kind, id, mode, owner: cfg.ownerQQ }); return true; },
    currentMode: 'active',
    getCurrentMode: () => 'reserved2',
  });
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(seen, [{ key: 'group:555', kind: 'group', id: GROUP, mode: 'reserved2', owner: OWNER }]);
  assert.equal(h.calls.appendSocialV2Message.length, 1, '模式取实时值 → 走 reserved2 分支');

  const fallback = [];
  const h2 = makeHarness({
    modeAllowed: (key, kind, id, cfg, mode) => { fallback.push(mode); return true; },
    currentMode: 'reserved2',
    getCurrentMode: undefined,
  });
  await h2.call('group', GROUP, groupEvent());
  assert.deepEqual(fallback, ['reserved2'], '没有 getter 时退回构造时快照（兼容旧调用）');
});

test('睡着时只有私聊/群里@能叫醒；群闲话不叫醒；被白名单拦下也已经叫醒', async () => {
  const sleep = () => ({ state: 'sleep' });
  const h = makeHarness({ getLifeState: sleep });
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.lifeNote[0][0], { type: 'incoming', fromSleep: true });
  assert.match(String(h.calls.lifeNote[0][1].log), /（私聊）把她叫醒了/);
  assert.equal(h.calls.touchLifeInterest.length, 1);

  const h2 = makeHarness({ getLifeState: sleep });
  await h2.call('group', GROUP, groupEvent());
  assert.equal(h2.calls.lifeNote, undefined, '群里闲话不该吵醒她');
  assert.equal(h2.calls.touchLifeInterest.length, 1, '无聊度锚点仍然复位');

  const h3 = makeHarness({ getLifeState: sleep, messageAtsSelf: () => true });
  await h3.call('group', GROUP, groupEvent());
  assert.match(String(h3.calls.lifeNote[0][1].log), /（群@）把她叫醒了/);

  const h4 = makeHarness({ getLifeState: sleep, modeAllowed: () => false });
  await h4.call('private', OWNER, privateEvent());
  assert.equal(h4.calls.lifeNote.length, 1, '叫醒发生在上层名单判定之前');
});

test('getLifeState 缺失时按「无生活状态」处理，不误触发叫醒', async () => {
  const h = makeHarness({ getLifeState: undefined });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.calls.lifeNote, undefined);
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1);
});

// ── 文本解析接线 ────────────────────────────────────────────────────────────

test('segmentsToText 调两次：带引用解析的全文 + 只要本文（不含引用原文）', async () => {
  const h = makeHarness();
  const event = groupEvent();
  await h.call('group', GROUP, event);
  assert.equal(h.calls.segmentsToText.length, 2);
  const [segs0, opts0] = h.calls.segmentsToText[0];
  assert.equal(segs0, event.message, '要传原 segments');
  assert.equal(opts0.includeReply, undefined, '第一次要引用原文（默认包含）');
  assert.equal(typeof opts0.resolveAtName, 'function');
  assert.equal(typeof opts0.resolveReply, 'function');
  const [, opts1] = h.calls.segmentsToText[1];
  assert.equal(opts1.includeReply, false, '第二次不能带引用原文，免得污染命令/指向性判断');
  assert.equal(typeof opts1.resolveAtName, 'function');
});

test('resolveAtName 只在群聊解析群名片；resolveReply 用 kind/id/self_id', async () => {
  const h = makeHarness();
  await h.call('group', GROUP, groupEvent());
  const opts = h.calls.segmentsToText[0][1];
  assert.equal(await opts.resolveAtName('3003'), 'NAME-3003');
  assert.deepEqual(h.calls.resolveGroupMemberName[0], [GROUP, '3003']);
  assert.equal(await opts.resolveReply('r9'), null);
  assert.deepEqual(h.calls.resolveReplyInfo[0], ['group', GROUP, 'r9', SELF]);

  const h2 = makeHarness();
  await h2.call('private', OWNER, privateEvent());
  const opts2 = h2.calls.segmentsToText[0][1];
  assert.equal(await opts2.resolveAtName('3003'), null, '私聊没有群成员概念');
  assert.equal(h2.calls.resolveGroupMemberName, undefined);
});

test('空消息且没有引用机器人自己：静默丢弃（也不查会话）', async () => {
  const h = makeHarness({ segmentsToText: async () => '' });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.isQuoteTargetSelf.length, 1, '空文本过滤必须在引用判定之后');
  assert.equal(h.calls.isSessionAllowedInCurrentMode.length, 1);
  assert.equal(h.calls.ensureSession, undefined);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
  assert.equal(h.calls.sendToQQ, undefined);
});

test('只引用机器人自己不附文字：视为直接对她说，继续投递', async () => {
  const h = makeHarness({ segmentsToText: async () => '', isQuoteTargetSelf: async () => true });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1);
  assert.equal(h.lastPrompt(), '【他】');
});

test('会话不在当前模式允许列表：丢弃（但引用解析已经发生）', async () => {
  const h = makeHarness({ isSessionAllowedInCurrentMode: () => false });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.isQuoteTargetSelf.length, 1);
  assert.equal(h.calls.ensureSession, undefined);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

test('群聊纯媒体消息（无文字、非引用）仍只缓存、不投递', async () => {
  const h = makeHarness({
    segmentsToText: async () => '',
    extractMediaFromSegments: () => [{ kind: 'image', file: 'a.jpg' }],
  });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined, '群聊空文本被过滤，媒体不触发');
  assert.equal(h.st.messageMediaStore.get('group:555')?.size, 2, '但 message_id/message_seq 两个 key 都缓存了');
});

test('私聊纯媒体（无文字、非引用）：放行投递，prompt 带媒体提示（2026-11-03 拍板）', async () => {
  const h = makeHarness({
    segmentsToText: async () => '',
    extractMediaFromSegments: () => [{ kind: 'image', file: 'a.jpg' }],
  });
  await h.call('private', OWNER, privateEvent({ message: [{ type: 'image', data: { file: 'a.jpg' } }] }));
  assert.equal(h.calls.submitPromptWithTurnSlot?.length, 1, '私聊只发图也要进模型，由她决定回不回');
  assert.match(h.lastPrompt(), /【附件:1】/, '媒体提示（生产里是【图片/表情】+ 消息 ID）不能为空');
});

test('私聊纯媒体：只有表情/无媒体列表时仍按空文本丢弃（不误放行）', async () => {
  const h = makeHarness({ segmentsToText: async () => '', extractMediaFromSegments: () => [] });
  await h.call('private', OWNER, privateEvent({ message: [] }));
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

// ── prompt 组装 ────────────────────────────────────────────────────────────

test('管理员私聊：角色提示 + 【他】标记，无发送者前缀、无群上下文', async () => {
  const h = makeHarness({ currentRoleHint: () => 'ROLE-HINT' });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.lastPrompt(), 'ROLE-HINT\n\n【他】hi');
  const req = h.submits()[0];
  assert.equal(req.kind, 'chat');
  assert.equal(req.label, 'private:1001');
  assert.equal(req.sessionId, 'sess-1');
  assert.equal(req.useSlot, true);
  assert.deepEqual(req.content, [{ type: 'text', text: 'ROLE-HINT\n\n【他】hi' }]);
});

test('群聊：发送者卡片优先、其次昵称、最后 QQ 号；群友没有【他】标记', async () => {
  const h = makeHarness();
  await h.call('group', GROUP, groupEvent());
  await h.call('group', GROUP, groupEvent({ message_id: 'g2', sender: { nickname: 'nickB' } }));
  await h.call('group', GROUP, groupEvent({ message_id: 'g3', sender: {} }));
  assert.deepEqual(h.prompts(), ['群友A：hello', 'nickB：hello', '2002：hello']);
});

test('引用对象是主人时注入【接的是他的话】', async () => {
  const h = makeHarness({ isQuoteTargetOwner: async () => true });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.lastPrompt(), '【接的是他的话】群友A：hello');

  const h2 = makeHarness({ isQuoteTargetOwner: async () => true });
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.lastPrompt(), '【他】【接的是他的话】hi');
});

test('引用解析失败按「不是引用」处理，不阻断消息', async () => {
  const h = makeHarness({ isQuoteTargetOwner: async () => { throw new Error('reply 解析炸了'); } });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.lastPrompt(), '群友A：hello');
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1);
});

test('媒体消息：附件提示拼进 prompt，图片作为独立 content 段交给 DSH', async () => {
  const media = [{ kind: 'image', file: 'a.jpg' }, { kind: 'image', file: 'b.jpg' }];
  const h = makeHarness({ extractMediaFromSegments: () => media });
  await h.call('group', GROUP, groupEvent());
  const req = h.submits()[0];
  assert.equal(req.content.length, 3, '文本 + 两张图');
  assert.equal(req.content[0].text, '群友A：hello【附件:2】');
  assert.deepEqual(req.content[1], { type: 'image', data: { idx: 0 } });
  assert.equal(h.calls.resolveMediaList[0][0], media);
});

test('withSlangContext 只在最外层包一次（黑话上下文）', async () => {
  const wrapped = [];
  const h = makeHarness({ withSlangContext: (t) => { wrapped.push(t); return `W|${t}|E`; } });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.lastPrompt(), 'W|【他】hi|E');
  assert.deepEqual(wrapped, ['【他】hi']);
});

test('ackMessage 在正常投递后回执；没有配置就不发', async () => {
  const h = makeHarness();
  await h.call('private', OWNER, privateEvent(), { ackMessage: '收到' });
  assert.deepEqual(h.calls.sendToQQ[0], ['private:1001', '收到']);
  assert.ok(h.logs().some((l) => l.includes('已投递 private:1001')));

  const h2 = makeHarness();
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.calls.sendToQQ, undefined);
});

test('turnDispatch 活跃时不抢槽位（useSlot=false）', async () => {
  const h = makeHarness({ turnDispatch: { isActive: () => true } });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.submits()[0].useSlot, false);
});

// ── 静默模式 / 控制话语 / 管理命令 ─────────────────────────────────────────

test('静默模式：群友消息只记录不投递，管理员照常对话', async () => {
  const h = makeHarness({ readRoleState: () => ({ mode: 'silent', role: null }) });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
  assert.equal(h.calls.handlePendingAnswer, undefined);
  assert.match(String(h.calls.appendActivity[0][0]), /（静默模式）群友 2002：hello/);
  assert.ok(h.logs().some((l) => l.includes('静默模式，忽略群友消息')));

  await h.call('private', OWNER, privateEvent());
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1, '管理员不受静默模式影响');
});

test('角色切换类话语：群友被拒并回执，管理员放行给 agent', async () => {
  const h = makeHarness({ segmentsToText: async () => '切换角色' });
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.sendToQQ[0], ['group:555', '角色切换仅管理员可在管理端操作，群内不支持。']);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);

  await h.call('private', OWNER, privateEvent());
  assert.equal(h.lastPrompt(), '【他】切换角色');
});

test('斜杠命令：群友一律拒绝', async () => {
  const h = makeHarness({ segmentsToText: async () => '/status' });
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.sendToQQ[0], ['group:555', '管理命令仅管理员可用。']);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

test('/status：回报会话/白名单/角色/模式（群友不在名单时显示拦截）', async () => {
  const h = makeHarness({ segmentsToText: async () => '/status' });
  h.st.state.sessions['private:1001'] = 'sess-9';
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.sendToQQ[0], ['private:1001', '会话 sess-9；白名单 通过；角色 无；模式 active']);

  const h2 = makeHarness({ segmentsToText: async () => '/status', allowed: () => false });
  await h2.call('private', OWNER, privateEvent());
  assert.match(String(h2.calls.sendToQQ[0][1]), /白名单 拦截/);
});

test('/role：清空 / 角色不存在 / 切换成功三种分支', async () => {
  const run = async (text, roleFile = null) => {
    const hh = makeHarness({ segmentsToText: async () => text });
    if (roleFile) {
      fs.mkdirSync(path.join(hh.root, 'roles'), { recursive: true });
      fs.writeFileSync(path.join(hh.root, 'roles', `${roleFile}.md`), '# 角色');
    }
    await hh.call('private', OWNER, privateEvent());
    return hh;
  };

  const cleared = await run('/role off');
  assert.deepEqual(cleared.calls.writeRoleState[0], [null, 'active']);
  assert.deepEqual(cleared.calls.sendToQQ[0], ['private:1001', '已清除角色，恢复正常人格。']);

  const blank = await run('/role   ');
  assert.deepEqual(blank.calls.writeRoleState[0], [null, 'active']);

  const missing = await run('/role nope');
  assert.equal(missing.calls.writeRoleState, undefined);
  assert.match(String(missing.calls.sendToQQ[0][1]), /角色「nope」不存在/);

  const hit = await run('/role kind', 'kind');
  assert.deepEqual(hit.calls.writeRoleState[0], ['kind', 'active']);
  assert.deepEqual(hit.calls.sendToQQ[0], ['private:1001', '已切换角色：kind。']);
  assert.equal(hit.calls.submitPromptWithTurnSlot, undefined, '角色命令不下发给模型');
});

test('/silent 与 /active（/quiet、/speak 别名）只切模式并回执', async () => {
  const run = async (text) => {
    const hh = makeHarness({ segmentsToText: async () => text, readRoleState: () => ({ mode: 'active', role: 'kind' }) });
    await hh.call('private', OWNER, privateEvent());
    return hh;
  };
  const silent = await run('/silent');
  assert.deepEqual(silent.calls.writeRoleState[0], ['kind', 'silent']);
  assert.deepEqual(silent.calls.sendToQQ[0], ['private:1001', '已进入静默模式：群友消息不再回复，仅管理员可对话。']);
  const quiet = await run('/quiet');
  assert.deepEqual(quiet.calls.writeRoleState[0], ['kind', 'silent']);
  const active = await run('/active');
  assert.deepEqual(active.calls.writeRoleState[0], ['kind', 'active']);
  assert.deepEqual(active.calls.sendToQQ[0], ['private:1001', '已退出静默模式，恢复正常回复。']);
  const speak = await run('/speak');
  assert.deepEqual(speak.calls.writeRoleState[0], ['kind', 'active']);
});

test('其它斜杠命令（如 /model）照常投递给 agent', async () => {
  const h = makeHarness({ segmentsToText: async () => '/model x' });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.lastPrompt(), '【他】/model x');
  assert.equal(h.calls.sendToQQ, undefined);
});

// ── /reset ─────────────────────────────────────────────────────────────────

test('/reset：清理该会话的全部状态、停旧会话、归档并回执', async () => {
  const h = makeHarness({ segmentsToText: async () => '/reset' });
  const key = 'private:1001';
  const old = 'sess-old';
  h.st.state.sessions[key] = old;
  h.st.state.sessionPolicies[key] = { model: 'x' };
  h.st.modelAppliedSessions.add(old);
  h.st.reverse.set(old, 'x');
  h.st.collectors.set(old, 'x');
  h.st.sendToolSucceededSessions.add(old);
  h.st.pendingSendToolCalls.set(old, []);
  h.st.v2TurnStartAt.set(old, 1);
  h.st.toolCallNames.set(old, new Map());
  h.st.social.silentTurns.add(old);
  h.st.social.exitingSessions.add(old);
  // 注意：不能预置 pending（提问/审批）—— line 331 会先把管理员消息当回答消费掉并 return，
  // 于是 /reset 根本走不到清理分支（那里的 cancelPendingEntry 实际上是死代码，见报告）。
  h.st.queued.set(key, []);
  h.st.queuedHintAt.set(key, 1);
  h.st.sessionPromises.set(key, Promise.resolve());
  h.st.social.recentMessages.set(key, []);
  h.st.messageMediaStore.set(key, new Map());
  h.st.social.pendingSummaries.set(key, []);
  h.st.social.states.set(key, {});
  h.st.social.silentContext.set(key, '');
  h.st.slangWindows.set(key, []);
  h.st.slangExtractionCooldowns.set(key, 1);
  h.st.slangSubmitTimes.set(key, 1);
  h.st.pendingWakeKeys.add(key);
  h.st.wakeConfigUpdatedKeys.add(key);
  h.st.markReadCalledKeys.add(key);
  h.st.wakeConfigMissCount.set(key, 1);
  h.st.socialV2.conversations.set(key, {});
  h.st.seenForwardIds.add(key);

  await h.call('private', OWNER, privateEvent());

  assert.equal(h.st.state.sessions[key], undefined);
  assert.equal(h.st.state.sessionPolicies[key], undefined);
  for (const set of [h.st.modelAppliedSessions, h.st.sendToolSucceededSessions,
    h.st.social.silentTurns, h.st.social.exitingSessions, h.st.pendingWakeKeys,
    h.st.wakeConfigUpdatedKeys, h.st.markReadCalledKeys, h.st.seenForwardIds]) {
    assert.equal(set.has(old) || set.has(key), false);
  }
  for (const map of [h.st.reverse, h.st.collectors, h.st.pendingSendToolCalls, h.st.v2TurnStartAt,
    h.st.toolCallNames, h.st.pending, h.st.queued, h.st.queuedHintAt, h.st.sessionPromises,
    h.st.social.recentMessages, h.st.messageMediaStore, h.st.social.pendingSummaries,
    h.st.social.states, h.st.social.silentContext, h.st.slangWindows,
    h.st.slangExtractionCooldowns, h.st.slangSubmitTimes, h.st.wakeConfigMissCount,
    h.st.socialV2.conversations]) {
    assert.equal(map.has(old) || map.has(key), false);
  }
  assert.equal(h.st.epoch, 1, '会话代际要 +1（旧回合的异步结果全部作废）');
  assert.equal(h.calls.bumpSessionEpoch.length, 1);
  assert.deepEqual(h.calls.drainPromptQueue[0], [key, '会话已重置']);
  assert.equal(h.calls.cancelSocialTimers.length, 1);
  assert.equal(h.calls.clearSocialV2Timers.length, 1);
  assert.equal(h.calls.forgetAgentToken[0][0], key);
  assert.equal(h.calls.saveSocialV2State.length, 1);
  assert.equal(h.calls.saveState.length, 1);
  assert.deepEqual(h.calls.stopSessionWork[0], [old]);
  assert.deepEqual(h.calls.archiveSession[0], [{ sessionId: old }]);
  assert.deepEqual(h.calls.sendToQQ[0], [key, '已重置会话，下次消息将开新上下文']);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);

  // 没有旧会话时静默返回：不清理、不停会话、不回执
  const h2 = makeHarness({ segmentsToText: async () => '/reset' });
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.calls.bumpSessionEpoch, undefined);
  assert.equal(h2.calls.stopSessionWork, undefined);
  assert.equal(h2.calls.sendToQQ, undefined);
});

test('/reset：停旧会话失败只记警告，归档与回执继续', async () => {
  const h = makeHarness({
    segmentsToText: async () => '/reset',
    api: {
      stopSessionWork: async () => { throw new Error('DSH 超时'); },
      workspace: { archiveSession: async () => {} },
    },
  });
  h.st.state.sessions['private:1001'] = 'sess-old';
  await h.call('private', OWNER, privateEvent());
  assert.ok(h.logs().some((l) => l.includes('停止旧会话失败') && l.includes('DSH 超时')));
  assert.deepEqual(h.calls.sendToQQ[0], ['private:1001', '已重置会话，下次消息将开新上下文']);
});

test('/reset 在挂起提问时仍按命令执行（不能被当成回答消费）', async () => {
  const h = makeHarness({ segmentsToText: async () => '/reset' });
  const key = 'private:1001';
  h.st.state.sessions[key] = 'sess-old';
  const p = { kind: 'question', timer: null };
  h.st.pending.set(key, p);
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.calls.handlePendingAnswer, undefined, '命令不能被 pending 当回答吃掉');
  assert.equal(h.st.state.sessions[key], undefined, '真的重置了');
  assert.equal(h.st.pending.has(key), false, 'pending 条目被清理');
  assert.deepEqual(h.calls.cancelPendingEntry[0], [p], '挂起的提问要取消');
  assert.deepEqual(h.calls.sendToQQ[0], [key, '已重置会话，下次消息将开新上下文']);
});

test('提交阶段下游抛错：异常向上冒，不吞、不发 ack', async () => {
  const h = makeHarness({ submitPromptWithTurnSlot: async () => { throw new Error('DSH 连接断了'); } });
  await assert.rejects(() => h.call('private', OWNER, privateEvent()), /DSH 连接断了/);
  assert.equal(h.calls.sendToQQ, undefined);
  assert.equal(h.calls.sendNotice, undefined);
});

// ── pending 提问/审批 ──────────────────────────────────────────────────────

test('挂起的提问：当前消息当作回答消费掉，不再投递', async () => {
  const h = makeHarness();
  const key = 'private:1001';
  const p = { kind: 'question' };
  h.st.pending.set(key, p);
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.handlePendingAnswer[0], [p, 'hi', key, true]);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

test('挂起的审批：只有管理员消息会消费，群友消息继续正常处理', async () => {
  const h = makeHarness();
  h.st.pending.set('group:555', { kind: 'approval' });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.handlePendingAnswer, undefined, '群友消息不能被审批挂起吞掉');
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1);

  const h2 = makeHarness();
  h2.st.pending.set('private:1001', { kind: 'approval' });
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.calls.handlePendingAnswer.length, 1, '管理员的审批回答要消费');
  assert.equal(h2.calls.submitPromptWithTurnSlot, undefined);
});

// ── 队列（DSH 不可用）──────────────────────────────────────────────────────

test('DSH 不可用：消息入队并提示；冷却窗口内不重复提示；满队列丢最旧', async () => {
  let text = 'm1';
  const h = makeHarness({
    getDshReady: () => false,
    segmentsToText: async () => text,
  });
  const key = 'private:1001';
  await h.call('private', OWNER, privateEvent({ message_id: 'm1' }));
  text = 'm2';
  await h.call('private', OWNER, privateEvent({ message_id: 'm2' }));
  assert.equal(h.st.queued.get(key).length, 2);
  assert.equal(h.calls.sendNotice.length, 1, '冷却窗口内不重复提示');
  assert.match(String(h.calls.sendNotice[0][1]), /⏳ 系统服务重启中，消息已排队，恢复后自动处理。/);
  assert.ok(h.logs().some((l) => l.includes('DSH 不可用，消息入队')));

  text = 'm3';
  await h.call('private', OWNER, privateEvent({ message_id: 'm3' }));
  assert.deepEqual(h.st.queued.get(key).map((x) => x.promptText), ['【他】m2', '【他】m3']);
  assert.ok(h.logs().some((l) => l.includes('队列满（2），丢弃最旧消息')));
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

test('getDshReady getter 优先于构造时快照；getter 缺失才退回快照', async () => {
  const h = makeHarness({ getDshReady: () => false, dshReady: true });
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.st.queued.size, 1, 'getter 说不可用 → 入队');
  assert.equal(h.calls.ensureSession, undefined);

  const h2 = makeHarness({ getDshReady: undefined, dshReady: false });
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.st.queued.size, 1, '没有 getter → 用快照');
});

// ── 会话创建 / 投递 / 被拒 ─────────────────────────────────────────────────

test('ensureSession：旧错误「会话创建期间已重置」走重试队列，不抛', async () => {
  const h = makeHarness({ ensureSession: async () => { throw new Error('会话创建期间已重置'); } });
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.enqueueForRetry[0], ['private:1001', '【他】hi', { media: [] }]);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
});

test('ensureSession：其它错误照原样抛出', async () => {
  const h = makeHarness({ ensureSession: async () => { throw new Error('DSH 创建会话失败'); } });
  await assert.rejects(() => h.call('private', OWNER, privateEvent()), /DSH 创建会话失败/);
  assert.equal(h.calls.enqueueForRetry, undefined);
});

test('投递前会话被重置/权限变化：抛出且不再投递', async () => {
  const h = makeHarness({ isCurrentSession: () => false });
  await assert.rejects(() => h.call('private', OWNER, privateEvent()), /投递前会话已重置或权限已变化/);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
  assert.equal(h.calls.sendNotice, undefined);
});

test('提交未被接受：把 code+message 回执给会话', async () => {
  const h = makeHarness({
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 'E_BUSY', message: '太忙了' } } }),
  });
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.sendNotice[0], ['private:1001', '⚠️ 消息未被接受：E_BUSY: 太忙了']);
  assert.equal(h.calls.sendToQQ, undefined, '没发出去就不发 ack');
});

test('提交失败的敏感信息：按 shouldAuditKey+SENSITIVE_RE 隐藏', async () => {
  const h = makeHarness({
    shouldAuditKey: () => true,
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 'E', message: 'token=secret-123' } } }),
  });
  await h.call('private', OWNER, privateEvent());
  assert.deepEqual(h.calls.sendNotice[0], ['private:1001', '⚠️ 消息未被接受：（含敏感信息，已隐藏）']);

  const h2 = makeHarness({
    shouldAuditKey: () => false,
    submitPromptWithTurnSlot: async () => ({ result: { ok: false, error: { code: 'E', message: 'token=secret-123' } } }),
  });
  await h2.call('private', OWNER, privateEvent());
  assert.deepEqual(h2.calls.sendNotice[0], ['private:1001', '⚠️ 消息未被接受：E: token=secret-123'], '不该审计的会话不隐藏');
});

test('DSH 直接返回命令结果：走 mdToPlain + 审计发送，不发 ack、不再当聊天', async () => {
  const h = makeHarness({
    submitPromptWithTurnSlot: async () => ({ result: { ok: true, value: { command: { text: '# 标题' } } } }),
  });
  await h.call('private', OWNER, privateEvent(), { ackMessage: '收到' });
  assert.deepEqual(h.calls.auditAndSend[0], ['private:1001', 'plain:# 标题']);
  assert.equal(h.calls.sendToQQ, undefined);

  const h2 = makeHarness({
    submitPromptWithTurnSlot: async () => ({ result: { ok: true, value: { command: {} } } }),
  });
  await h2.call('private', OWNER, privateEvent());
  assert.equal(h2.calls.auditAndSend, undefined, '命令没有文本就不发');
});

// ── 媒体存储 ───────────────────────────────────────────────────────────────

test('媒体存储：message_id 与 message_seq 双 key，超上限丢最旧，无 id 不存', async () => {
  const media = [{ kind: 'image', file: 'a.jpg' }];
  const h = makeHarness({ extractMediaFromSegments: () => media });
  await h.call('group', GROUP, groupEvent({ message_id: 'g1', message_seq: undefined }));
  const store = h.st.messageMediaStore.get('group:555');
  assert.deepEqual([...store.keys()], ['g1']);
  assert.equal(store.get('g1'), media);

  h.st.messageMediaStore.clear();
  await h.call('group', GROUP, groupEvent({ message_id: 'g1', message_seq: 21 }));
  assert.deepEqual([...h.st.messageMediaStore.get('group:555').keys()], ['g1', '21']);

  for (const id of ['g2', 'g3', 'g4']) {
    await h.call('group', GROUP, groupEvent({ message_id: id, message_seq: undefined }));
  }
  const store2 = h.st.messageMediaStore.get('group:555');
  assert.equal(store2.size, 3, 'MAX_MEDIA_STORE_PER_KEY=3');
  assert.deepEqual([...store2.keys()], ['g2', 'g3', 'g4'], '丢最旧留最新');

  await h.call('group', GROUP, groupEvent({ message_id: undefined, message_seq: undefined }));
  assert.equal(store2.size, 3, '没有 message_id/seq 时不往存储里塞空 key');
});

// ── 转发预读 ───────────────────────────────────────────────────────────────

test('转发卡片：预读文本带「别处对话」标注、图片并入同一附件链（封顶 8）', async (t) => {
  // 源码用 Promise.race(bot.raw, 5s 超时) 且不清理超时器；把计时器换掉，测试进程不用干等 5 秒。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const five = Array.from({ length: 5 }, (_, i) => ({ kind: 'image', file: `${i}.jpg` }));
  const rawCalls = [];
  const h = makeHarness({
    extractForwardIds: () => ['f1'],
    bot: {
      raw: async (...args) => { rawCalls.push(args); return [{ message: [{ type: 'image' }] }]; },
    },
    formatForwardResponse: () => ({
      total: 5,
      truncated: true,
      messages: [
        { sender: '张三', text: '你好', media: [{ kind: 'image' }, { kind: 'image' }, { kind: 'video-thumb' }] },
        { sender: '', text: '无图', media: [], nestedForwardIds: ['n2'] },
      ],
    }),
    extractMediaFromSegments: () => five,
  });
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(rawCalls[0], ['get_forward_msg', { id: 'f1' }]);
  const prompt = h.lastPrompt();
  assert.match(prompt, /【转发的聊天记录，5 条（已截断）——这是别处的对话，不是本群说的话】/);
  assert.match(prompt, /张三：你好（张三附了 2 张图、1 个视频封面）/);
  assert.match(prompt, /：无图（内含另一张转发卡片，工具可再读）/);
  assert.ok(h.logs().some((l) => l.includes('[forward] group:555 预读 1 张转发卡片')));
  const store = h.st.messageMediaStore.get('group:555');
  assert.equal(store.get('g1').length, 8, '正常消息 5 张 + 转发 5 张 → 总附件封顶 8');
  assert.equal(store.get('21').length, 8, 'seq key 也合并');
  assert.equal(store.get('g1')[0], five[0], '先放当前消息自己的图，再补转发的');
});

test('转发卡片：maxChars 截断并提示用工具深读；images=false 不提取转发图', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    extractForwardIds: () => ['f1'],
    bot: { raw: async () => [] },
    formatForwardResponse: () => ({ total: 1, truncated: false, messages: [{ sender: '张三', text: '这是一段很长的话', media: [] }] }),
  });
  await h.call('group', GROUP, groupEvent(), { socialV2: { forward: { maxChars: 3 } } });
  assert.match(h.lastPrompt(), /……（更长内容用 qq_get_forward_msg 工具读）/);

  const mediaCalls = [];
  const h2 = makeHarness({
    extractForwardIds: () => ['f1'],
    bot: { raw: async () => [{ message: [{ type: 'image' }] }] },
    formatForwardResponse: () => ({ total: 1, truncated: false, messages: [{ sender: '张三', text: '你好', media: [] }] }),
    extractMediaFromSegments: (...args) => { mediaCalls.push(args); return [{ kind: 'image', file: 'a.jpg' }]; },
  });
  await h2.call('group', GROUP, groupEvent(), { socialV2: { forward: { images: false } } });
  assert.equal(mediaCalls.length, 1, '只提取当前消息自己的图');
  assert.equal(h2.st.messageMediaStore.get('group:555').get('g1').length, 1);
});

test('转发预读失败：记一行日志，消息继续投递；开关关闭时根本不拉取', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    extractForwardIds: () => ['f1'],
    bot: { raw: async () => { throw new Error('API 超时'); } },
  });
  await h.call('group', GROUP, groupEvent());
  assert.ok(h.logs().some((l) => l.includes('预读失败') && l.includes('API 超时')));
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1);

  const h2 = makeHarness({ extractForwardIds: () => ['f1'] });
  await h2.call('group', GROUP, groupEvent(), { socialV2: { forward: { enabled: false } } });
  assert.equal(h2.calls.extractForwardIds, undefined);
  assert.equal(h2.calls.botRaw, undefined);
});

// ── 粘贴型聊天记录 / 链接预读 ───────────────────────────────────────────────

test('粘贴型聊天记录（≥3 个「人名：内容」行）加一行转述提示，2 行不提示', async () => {
  const paste = '张三：你好呀\n李四：我吃了吗\n王五：吃过了';
  const h = makeHarness({ segmentsToText: async () => paste });
  await h.call('group', GROUP, groupEvent());
  assert.match(h.lastPrompt(), /【提示：上面的文字像是别人粘贴\/转述的聊天记录/);
  assert.ok(h.logs().some((l) => l.includes('检测到粘贴型聊天记录（3 个对话行）')));

  const h2 = makeHarness({ segmentsToText: async () => '张三：你好呀\n李四：我吃了吗' });
  await h2.call('group', GROUP, groupEvent());
  assert.ok(!h2.lastPrompt().includes('【提示：上面的文字像是别人粘贴'), '只有 2 行不误报');
});

test('链接预读：收消息即读第一条（最多 maxLinks 条），linkRead=false 不读', async () => {
  const h = makeHarness({ extractLinks: () => ['http://example.com/a'] });
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.readPageForIntake[0], ['http://example.com/a', true]);
  assert.ok(h.logs().some((l) => l.includes('[intake] 预读链接（收消息即开始）')));

  const seen = [];
  const h2 = makeHarness({ extractLinks: (text, max) => { seen.push(max); return ['http://x']; } });
  await h2.call('group', GROUP, groupEvent(), { socialV2: { intake: { maxLinks: 5 } } });
  assert.deepEqual(seen, [5]);

  const h3 = makeHarness({ extractLinks: () => ['http://x'] });
  await h3.call('group', GROUP, groupEvent(), { socialV2: { intake: { linkRead: false } } });
  assert.equal(h3.calls.readPageForIntake, undefined);
});

// ── ASR（语音转写）─────────────────────────────────────────────────────────

test('ASR：语音消息拉回转写并补进 prompt（带 token 时带 Bearer）', async (t) => {
  const reqs = [];
  await stubGlobalFetch(t, async (url, init) => {
    reqs.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { text: '你好呀' } }) };
  });
  const h = makeHarness({ segmentsToText: async () => '他说 [语音] 这样' });
  await h.call('private', OWNER, privateEvent({
    message: [{ type: 'text' }, { type: 'record', data: { file: 'a.amr' } }],
  }), { socialV2: {}, snowluma: { accessToken: 'tok' } });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, 'http://127.0.0.1:3000/fetch_ptt_text');
  assert.equal(reqs[0].init.method, 'POST');
  assert.equal(reqs[0].init.headers.authorization, 'Bearer tok');
  assert.equal(reqs[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(reqs[0].body, { message_id: 'm1' });
  assert.ok(reqs[0].init.signal, '必须带超时 signal');
  assert.match(h.lastPrompt(), /（语音转文字：你好呀）/);
  assert.ok(h.logs().some((l) => l.includes('[asr] private:1001 语音已转文字（3 字）')));
});

test('ASR：关闭开关、没有 message_id、非语音消息都不发请求', async (t) => {
  const reqs = [];
  await stubGlobalFetch(t, async (url) => { reqs.push(url); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'x' } }) }; });
  const record = [{ type: 'text' }, { type: 'record', data: {} }];
  const h = makeHarness({ segmentsToText: async () => '[语音]' });
  await h.call('private', OWNER, privateEvent({ message: record }), { socialV2: { asr: { enabled: false } } });
  assert.equal(reqs.length, 0, 'asr.enabled=false 不拉');

  const h2 = makeHarness({ segmentsToText: async () => '[语音]' });
  await h2.call('private', OWNER, privateEvent({ message_id: undefined, msg_id: undefined, message: record }));
  assert.equal(reqs.length, 0, '没有 message_id 无从转写');

  const h3 = makeHarness({ segmentsToText: async () => '纯文本' });
  await h3.call('private', OWNER, privateEvent());
  assert.equal(reqs.length, 0, '没有 record 段不发');
});

test('ASR：转写返回非 ok 只记日志；网络异常吞掉不影响收信', async (t) => {
  await stubGlobalFetch(t, async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 100, data: {} }) }));
  const h = makeHarness({ segmentsToText: async () => '[语音]' });
  await h.call('private', OWNER, privateEvent({ message: [{ type: 'record', data: {} }] }));
  assert.ok(h.logs().some((l) => l.includes('语音转写不可用（retcode=100）')));
  assert.ok(!h.lastPrompt().includes('语音转文字'));
  assert.equal(h.calls.submitPromptWithTurnSlot.length, 1, '转写不可用不影响收信');

  await stubGlobalFetch(t, async () => ({ ok: false, json: async () => ({ status: 'ok', retcode: 0 }) }));
  const h2 = makeHarness({ segmentsToText: async () => '[语音]' });
  await h2.call('private', OWNER, privateEvent({ message: [{ type: 'record', data: {} }] }));
  assert.ok(h2.logs().some((l) => l.includes('语音转写不可用（retcode=0）')));

  await stubGlobalFetch(t, async () => { throw new Error('网络断了'); });
  const h3 = makeHarness({ segmentsToText: async () => '[语音]' });
  await h3.call('private', OWNER, privateEvent({ message: [{ type: 'record', data: {} }] }));
  assert.ok(h3.logs().some((l) => l.includes('转写失败（已忽略）: 网络断了')));
  assert.equal(h3.calls.submitPromptWithTurnSlot.length, 1);
});

test('ASR：转写文本截 300 字；坏 JSON 按不可用处理', async (t) => {
  await stubGlobalFetch(t, async () => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { text: '长'.repeat(400) } }) }));
  const h = makeHarness({ segmentsToText: async () => '[语音]' });
  await h.call('private', OWNER, privateEvent({ message: [{ type: 'record', data: {} }] }));
  assert.match(h.lastPrompt(), new RegExp(`（语音转文字：${'长'.repeat(300)}）`));
  assert.ok(!h.lastPrompt().includes('长'.repeat(301) + '）'));
  assert.ok(h.logs().some((l) => l.includes('语音已转文字（300 字）')), '日志按截断后的实际字数报，和正文一致');

  await stubGlobalFetch(t, async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }));
  const h2 = makeHarness({ segmentsToText: async () => '[语音]' });
  await h2.call('private', OWNER, privateEvent({ message: [{ type: 'record', data: {} }] }));
  assert.ok(h2.logs().some((l) => l.includes('语音转写不可用（retcode=?）')));
});

// ── reserved2（二代仿真）───────────────────────────────────────────────────

function reserved2(overrides = {}) {
  return makeHarness({ getCurrentMode: () => 'reserved2', ...overrides });
}

test('reserved2：第一条消息只做 bootstrap 唤醒，并把消息写进二代会话', async (t) => {
  // 转发预读用 Promise.race(bot.raw, 5s 超时)；这里只验入参透传，换掉计时器免得进程干等。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const event = groupEvent({ sender: { card: '群友[color=red]A', nickname: 'nickA' } });
  const fwdIds = ['f9'];
  const hh = reserved2({ extractForwardIds: () => fwdIds });
  await hh.call('group', GROUP, event);
  const st = hh.getV2('group:555');
  assert.equal(st.bootstrapSent, true);
  assert.deepEqual(hh.calls.scheduleWakeV2[0], ['group:555', 'bootstrap']);
  assert.equal(hh.calls.saveSocialV2State.length, 1);
  const args = hh.calls.appendSocialV2Message[0];
  assert.equal(args[0], 'group:555');
  assert.equal(args[1], '群友A', '彩色昵称控制码在入口洗掉');
  assert.equal(args[2], 'hello');
  assert.equal(args[3], 'hello');
  assert.equal(args[4], false);
  assert.equal(args[5], false);
  assert.equal(args[6], 'g1');
  assert.deepEqual(args[7], []);
  assert.equal(args[8], '2002');
  assert.deepEqual(args[9], fwdIds);
  assert.equal(hh.calls.noteCorrection[0][0], 'group:555');
  assert.equal(hh.calls.recordStickerCandidate.length, 1);
  assert.equal(hh.calls.feedSlangWindow.length, 1);
  assert.equal(hh.calls.submitPromptWithTurnSlot, undefined);
});

test('reserved2：私聊发送者记为「私聊」；暂停时只入库不唤醒', async () => {
  const h = reserved2();
  await h.call('private', OWNER, privateEvent());
  assert.equal(h.calls.appendSocialV2Message[0][1], '私聊');
  assert.equal(h.calls.feedSlangWindow, undefined, '私聊不进黑话窗口');

  const h2 = reserved2();
  h2.st.socialV2.paused = true;
  await h2.call('group', GROUP, groupEvent());
  assert.equal(h2.calls.scheduleWakeV2, undefined);
  assert.equal(h2.getV2('group:555').bootstrapSent, false, '暂停时连 bootstrap 都不标');
  assert.ok(h2.calls.appendActivity.some(([m]) => String(m).includes('[reserved2] AI 已暂停，消息仅入库不唤醒')));
});

test('reserved2 唤醒：秘书放行才排唤醒；aboutSelf 记住 sender 并落盘', async () => {
  const h = reserved2({ evaluateWakeTriggerV2: () => 'aboutSelf:nickname' });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.scheduleWakeV2[0], ['group:555', 'aboutSelf:nickname']);
  assert.equal(st.lastAboutSelf.senderId, '2002');
  assert.equal(typeof st.lastAboutSelf.at, 'number');
  assert.equal(h.calls.saveSocialV2State.length, 1);

  const h2 = reserved2({ evaluateWakeTriggerV2: () => 'addressed' });
  h2.getV2('group:555').bootstrapSent = true;
  await h2.call('group', GROUP, groupEvent());
  assert.deepEqual(h2.calls.scheduleWakeV2[0], ['group:555', 'addressed']);
  assert.equal(h2.getV2('group:555').lastAboutSelf, null, '只有 aboutSelf 才写节流锚点');
});

test('reserved2：秘书明确 should_reply=false 时不排唤醒、也不接话，只留日志', async () => {
  const h = reserved2({
    evaluateWakeTriggerV2: () => 'addressed',
    secretaryJudge: async () => ({ should_reply: false, addressed: 'no', why: '不是跟她说' }),
  });
  h.getV2('group:555').bootstrapSent = true;
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.scheduleWakeV2, undefined);
  assert.equal(h.calls.maybeJoinOrContinue, undefined);
  assert.ok(h.logs().some((l) => l.includes('[secretary] group:555 拦下唤醒 addressed → no/不是跟她说')));
  assert.ok(h.calls.appendActivity.some(([m]) => String(m).includes('[secretary] 拦下 addressed（no）')));
});

test('reserved2：秘书判定抛错/无 verdict 一律放行；没有唤醒理由时群聊才考虑接话', async () => {
  const h = reserved2({
    evaluateWakeTriggerV2: () => 'addressed',
    secretaryJudge: async () => { throw new Error('模型没起'); },
  });
  h.getV2('group:555').bootstrapSent = true;
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.scheduleWakeV2[0], ['group:555', 'addressed'], '判不了就放行');

  const h2 = reserved2();
  h2.getV2('group:555').bootstrapSent = true;
  await h2.call('group', GROUP, groupEvent());
  assert.equal(h2.calls.maybeJoinOrContinue.length, 1);
  assert.equal(h2.calls.scheduleWakeV2, undefined);

  const h3 = reserved2();
  h3.getV2('private:1001').bootstrapSent = true;
  await h3.call('private', OWNER, privateEvent());
  assert.equal(h3.calls.maybeJoinOrContinue, undefined, '私聊不走「群在聊」的接话机会');
});

test('reserved2：aboutSelfAllowed 同一人 10 分钟内只放行一次，换人/超时后恢复', async () => {
  let captured;
  const h = reserved2({
    evaluateWakeTriggerV2: (key, st, event, kind, text, plain, quoteSelf, options) => { captured = options; return null; },
  });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  st.lastAboutSelf = { senderId: '2002', at: Date.now() };
  await h.call('group', GROUP, groupEvent());
  assert.equal(captured.aboutSelfAllowed('2002'), false, '同一个人刚议论过她就别再叫醒');
  assert.equal(captured.aboutSelfAllowed('3003'), true);
  assert.equal(captured.selfNickname, '小助手');
  assert.equal(captured.cfg.ownerQQ, OWNER);
  st.lastAboutSelf = { senderId: '2002', at: Date.now() - 11 * 60 * 1000 };
  assert.equal(captured.aboutSelfAllowed('2002'), true, '超过 10 分钟恢复');
});

test('reserved2：语用框/情绪自学习 —— 纠正反馈、校准结果、情绪猜测与话语状态', async () => {
  const frame = { kind: 'jest', emotion: { label: 'joy', confidence: 0.8 } };
  const frameCalls = [];
  const fbCalls = [];
  const calCalls = [];
  const h = reserved2({
    classifyPragmaticFrame: (...args) => { frameCalls.push(args); return frame; },
    detectEmotionCorrection: () => true,
    recordEmotionFeedback: (cal, fb) => { fbCalls.push([cal, fb]); return { feedbacks: [fb] }; },
    applyEmotionCalibration: (emotion, calibration, key) => {
      calCalls.push([emotion, calibration, key]);
      return { ...emotion, label: 'calibrated', confidence: 0.9 };
    },
    updateDiscourseState: () => ({ turns: 3 }),
  });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  st.lastEmotionGuess = { label: 'sad', confidence: 0.7 };
  st.recentMessages = [
    { isSelf: true, text: '我自己说的' },
    { isSelf: false, text: '上一条' },
  ];
  await h.call('group', GROUP, groupEvent());
  assert.equal(frameCalls[0][0], 'hello');
  assert.deepEqual(frameCalls[0][1].recent, ['上一条'], '只看别人的话当语境');
  assert.deepEqual(fbCalls[0][1], { key: 'group:555', label: 'sad', corrected: true });
  assert.deepEqual(st.emotionCalibration, { feedbacks: [{ key: 'group:555', label: 'sad', corrected: true }] });
  assert.equal(calCalls[0][2], 'group:555');
  assert.equal(st.lastPragmaticFrame.emotion.label, 'calibrated');
  assert.equal(st.lastPragmaticFrame.seq, 7);
  assert.equal(st.lastPragmaticFrame.text, 'hello');
  assert.equal(st.lastEmotionGuess.label, 'calibrated');
  assert.equal(st.lastEmotionGuess.confidence, 0.9);
  assert.deepEqual(st.discourse, { turns: 3 });
});

test('reserved2：没有语用框 / 置信度不足 / 没有上次猜测时都不乱写状态', async () => {
  const h = reserved2({
    classifyPragmaticFrame: () => ({ kind: 'talk', emotion: { label: 'joy', confidence: 0.2 } }),
    detectEmotionCorrection: () => true,
  });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  await h.call('group', GROUP, groupEvent());
  assert.equal(st.lastPragmaticFrame.emotion.label, 'joy');
  assert.equal(st.lastEmotionGuess, null, '置信度 < 0.4 不记猜测');
  assert.equal(h.calls.recordEmotionFeedback, undefined, '没有上次猜测就没有「纠正」可记');
  assert.ok(st.discourse);

  const h2 = reserved2({ classifyPragmaticFrame: () => null });
  const st2 = h2.getV2('group:555');
  st2.bootstrapSent = true;
  await h2.call('group', GROUP, groupEvent());
  assert.equal(st2.lastPragmaticFrame, null);
  assert.equal(st2.discourse, null);
});

test('reserved2：社交图谱记回复边/相邻边/@边，跳过她自己和 @all', async () => {
  const edgeCalls = [];
  const h = reserved2({
    extractForwardIds: () => [],
    firstReplyId: () => 'r1',
    resolveReplyInfo: async (kind, id, mid) => (mid === 'r1' ? { sender: '张三', senderUserId: '2002' } : null),
    noteEdge: (...args) => { edgeCalls.push(args); return true; },
  });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  st.recentMessages = [{ sender: '李四', text: '上一句' }];
  await h.call('group', GROUP, groupEvent({
    message: [
      { type: 'text', data: { text: 'hello' } },
      { type: 'at', data: { qq: '3003' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: SELF } },
    ],
  }));
  const edges = edgeCalls.map(([graph, key, from, to, kind]) => ({ key, from, to, kind }));
  assert.deepEqual(edges, [
    { key: 'group:555', from: '群友A', to: '张三', kind: 'reply' },
    { key: 'group:555', from: '群友A', to: '李四', kind: 'adjacent' },
    { key: 'group:555', from: '群友A', to: 'NAME-3003', kind: 'mention' },
  ]);
  assert.equal(h.calls.saveSocialGraphSoon.length, 3);
  assert.deepEqual(h.calls.resolveGroupMemberName.map(([gid, qq]) => qq), ['3003'], '@all 和 @自己都不查');
  for (const [, , , to] of edgeCalls) assert.ok(!String(to).includes('[object Promise]'), 'async 名字必须 await');
});

test('reserved2：引用的是她自己 → 不记回复边；同一个人连发 → 不记相邻边', async () => {
  const h = reserved2({
    firstReplyId: () => 'r1',
    resolveReplyInfo: async () => ({ sender: '小助手', senderUserId: SELF }),
  });
  const st = h.getV2('group:555');
  st.bootstrapSent = true;
  st.recentMessages = [{ sender: '群友A', text: '我自己刚说的' }];
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.noteEdge, undefined, '引用自己 + 上一条也是自己 → 没有边');
});

test('reserved2：noteEdge 抛错不影响消息入库（图谱是旁路）', async () => {
  const h = reserved2({
    firstReplyId: () => 'r1',
    resolveReplyInfo: async () => ({ sender: '张三', senderUserId: '2002' }),
    noteEdge: () => { throw new Error('图谱写盘失败'); },
  });
  h.getV2('group:555').bootstrapSent = true;
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.appendSocialV2Message.length, 1, '消息照常入库');
  assert.equal(h.calls.scheduleWakeV2, undefined);
});

// ── 社交模式（reserved）────────────────────────────────────────────────────

function social(overrides = {}) {
  return makeHarness({ isSocialEnabled: () => true, ...overrides });
}

test('社交模式：退场中/活跃超时的新消息只进摘要，不投递', async () => {
  const exiting = social();
  exiting.socialState('group:555').phase = 'exiting';
  await exiting.call('group', GROUP, groupEvent());
  assert.equal(exiting.calls.appendSummary.length, 1);
  assert.equal(exiting.calls.appendRecentMessage.length, 1);
  assert.equal(exiting.calls.submitPromptWithTurnSlot, undefined);
  assert.ok(exiting.logs().some((l) => l.includes('退场中，新消息转入摘要')));

  const timeout = social({ triggerActiveDurationExit: () => true });
  timeout.socialState('group:555').phase = 'active';
  await timeout.call('group', GROUP, groupEvent());
  assert.equal(timeout.calls.appendSummary.length, 1);
  assert.ok(timeout.logs().some((l) => l.includes('活跃超时退场中，新消息转入摘要')));
  assert.equal(timeout.calls.submitPromptWithTurnSlot, undefined);
});

// 【回归测试】这段路径曾有一个真实缺陷（本次补测发现）：
// 旧代码在 `if (isSocialEnabled()) {…}` 块里第 640 行又写了一次
// `const roleHint = currentRoleHint()`，与外层第 570 行同名。块级 const 会遮蔽外层变量并
// 从块入口进入 TDZ，于是「社交模式 + 活跃私聊」在 612 行读 roleHint 时直接
// ReferenceError: Cannot access 'roleHint' before initialization ——
// 私聊消息既不即时投递、也不进摘要/队列（app.mjs 只 log 一句「处理私聊消息出错」）。
// 群聊活跃路径不碰 roleHint，所以只有私聊坏掉，容易长期漏检。
// 修复：删掉块内重复声明，复用外层同一次消息快照（源码现留 [TDZ] 注释）。
// 这条测试守住行为：活跃期私聊必须按配置延迟即时投递。
test('回归：社交模式活跃中私聊必须即时投递（历史 TDZ：块内重复声明 roleHint）', async () => {
  const h = social({ currentRoleHint: () => 'RH' });
  h.socialState('private:1001').phase = 'active';
  await h.call('private', OWNER, privateEvent(), { social: { activeReplyDelayMinMs: 100, activeReplyDelayMaxMs: 200 } });
  const args = h.calls.scheduleSocialReply[0];
  assert.deepEqual(args.slice(0, 2), ['private:1001', 'RH\n\n【他】hi'], '角色提示也必须还在（旧的 TDZ 会让整条路径抛错）');
  assert.equal(args[2], 100);
  assert.equal(args[3], 200);
  assert.equal(args[4], '私聊即时回应');
  assert.equal(args[5], false);
  assert.deepEqual(args[6], []);
  assert.equal(h.calls.submitPromptWithTurnSlot, undefined);
  assert.ok(h.logs().some((l) => l.includes('私聊活跃中收到消息，即时投递')));
});

test('社交模式：活跃中群聊只等批量检测，不即时投递', async () => {
  const g = social();
  g.socialState('group:555').phase = 'active';
  const st = g.socialState('group:555');
  await g.call('group', GROUP, groupEvent());
  assert.equal(g.calls.scheduleSocialReply, undefined);
  assert.equal(g.calls.appendSummary, undefined, '活跃中群聊也不进摘要（等批量检测）');
  assert.equal(typeof st.lastActiveMessageAt, 'number');
  assert.ok(g.logs().some((l) => l.includes('活跃中收到消息，等待批量检测')));
});

test('社交模式：试探(probing)收到消息即回活跃，清掉试探截止时间', async () => {
  const h = social();
  const st = h.socialState('group:555');
  st.phase = 'probing';
  st.probeDeadline = 12345;
  await h.call('group', GROUP, groupEvent());
  assert.equal(st.phase, 'active');
  assert.equal(st.probeDeadline, 0);
  assert.ok(st.lastActiveMessageAt > 0);
});

test('社交模式：观望中明确对她说 → 进活跃、贴上下文与指令，不直接投递', async () => {
  const h = social({ isDirectAddress: () => true });
  await h.call('group', GROUP, groupEvent());
  assert.equal(h.calls.enterActive.length, 1);
  const [key, prompt, minMs, maxMs, reason, silent, media] = h.calls.scheduleSocialReply[0];
  assert.equal(key, 'group:555');
  assert.equal(minMs, 2000);
  assert.equal(maxMs, 8000);
  assert.equal(reason, '触发进入活跃');
  assert.equal(silent, false);
  assert.deepEqual(media, []);
  assert.match(prompt, /【群聊上下文】\nCTX-BLOCK\n【当前消息】群友A：hello/);
  assert.match(prompt, /请回复消息。/);
  assert.match(prompt, /\[分段\]/);
  assert.ok(!prompt.includes('[沉默]'), '明确对她说就不要给「可以沉默」的出口');
});

test('社交模式：管理员私聊触发 → 立即 deliverPrompt（附 media）；引用机器人自己也算 direct', async () => {
  const h = social({ isDirectAddress: () => true });
  await h.call('private', OWNER, privateEvent(), {});
  assert.equal(h.calls.deliverPrompt.length, 1);
  const [key, prompt, opts] = h.calls.deliverPrompt[0];
  assert.equal(key, 'private:1001');
  assert.match(prompt, /【当前消息】【他】私聊：hi/);
  assert.deepEqual(opts, { media: [] });
  assert.ok(h.logs().some((l) => l.includes('管理员私聊触发，立即投递')));

  const quoted = social({ isDirectAddress: () => false, isQuoteTargetSelf: async () => true });
  await quoted.call('group', GROUP, groupEvent());
  assert.equal(quoted.calls.enterActive.length, 1, '只引用她也算直接对她说');
  assert.match(quoted.calls.scheduleSocialReply[0][1], /请回复消息。/);
});

test('社交模式：观望中不满足条件 → 进摘要、不唤醒；随机命中 → 给「可沉默」指令', async () => {
  const quiet = social({ isDirectAddress: () => false });
  await quiet.call('group', GROUP, groupEvent(), { social: { triggerProbability: 0 } });
  assert.equal(quiet.calls.enterActive, undefined);
  assert.equal(quiet.calls.appendSummary.length, 1);
  assert.match(String(quiet.calls.appendSummary[0][2]), /hello/);
  assert.ok(quiet.logs().some((l) => l.includes('观望中未触发')));

  const random = social({ isDirectAddress: () => false });
  await random.call('group', GROUP, groupEvent(), { social: { triggerProbability: 1 } });
  assert.equal(random.calls.enterActive.length, 1);
  assert.match(random.calls.scheduleSocialReply[0][1], /请根据情况决定是否回复/);
  assert.match(random.calls.scheduleSocialReply[0][1], /\[沉默\]/);
});

test('社交模式：带引用时注入方向提示，避免她把引用原文当成在叫她', async () => {
  const h = social({ isDirectAddress: () => true, segmentsToText: async () => '看这个 [引用: 张三]' });
  await h.call('group', GROUP, groupEvent());
  const prompt = h.calls.scheduleSocialReply[0][1];
  assert.match(prompt, /\[方向:这句是对她说的\]\n\[分段\]/);
});

test('社交模式：群聊消息进入黑话窗口（发送者用卡片名），私聊不进', async () => {
  const h = social();
  h.socialState('group:555').phase = 'active';
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.feedSlangWindow[0], ['group:555', '群友A', 'hello']);

  const p = social();
  p.socialState('private:1001').phase = 'idle';
  await p.call('private', OWNER, privateEvent(), { social: { triggerProbability: 0 } });
  assert.equal(p.calls.feedSlangWindow, undefined);
});

test('非社交模式下群聊也会喂黑话窗口，私聊不会', async () => {
  const h = makeHarness();
  await h.call('group', GROUP, groupEvent());
  assert.deepEqual(h.calls.feedSlangWindow[0], ['group:555', '群友A', 'hello']);

  const p = makeHarness();
  await p.call('private', OWNER, privateEvent());
  assert.equal(p.calls.feedSlangWindow, undefined);
});
