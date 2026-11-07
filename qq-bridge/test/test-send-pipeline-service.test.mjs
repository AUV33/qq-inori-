// send-pipeline 的纯逻辑金标：媒体句柄、间隔、审计门、发送前拦截。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendPipeline } from '../src/domain/send/send-pipeline-service.mjs';
import { rememberAgentToken, forgetAgentToken } from '../src/bootstrap/agent-tokens.mjs';

function ctx(overrides = {}) {
  const sent = [];
  const notices = [];
  const activity = [];
  const mediaStore = new Map();
  const conversations = new Map();
  const state = { mode: 'chat', st: null, paused: false };
  const base = {
    cfg: { ownerQQ: 123, socialV2: { send: {}, security: {} } },
    log: () => {},
    state: { sessions: {} },
    getSocialV2State: () => state.st ?? { recentMessages: [], unread: [] },
    saveSocialV2State: () => {},
    isSessionAllowedInCurrentMode: () => true,
    getCurrentMode: () => state.mode,
    onebotSend: async () => {},
    sendToQQ: async (key, text) => { sent.push([key, text]); },
    sendNotice: async (key, text) => { notices.push([key, text]); },
    sessionPolicy: () => ({}),
    splitClauses: (text) => [text],
    stripSelfQuoting: (text) => text,
    createSendGuard: () => () => {},
    ackCeilForReply: () => 0,
    autoAckAfterSend: () => {},
    maybeIntake: () => {},
    relevanceCos: () => 0,
    sleep: async () => {},
    randInt: (min, max) => min,
    loadMoodState: () => null,
    saveMoodState: () => {},
    noteMoodReply: () => {},
    effectiveWarmth: () => 0.5,
    detectSleepClaim: () => null,
    detectLateSleepClaim: () => null,
    lifeNote: () => {},
    loadInterestEncounters: () => ({ items: [] }),
    saveInterestEncounters: () => {},
    detectLikes: () => [],
    recordEncounter: () => {},
    markInterest: () => {},
    addRumination: () => {},
    detectRumination: () => null,
    scheduleChaseV2: () => {},
    setInputStatus: () => {},
    shouldBlockSilentReplyPure: () => false,
    groupMutedUntil: () => 0,
    muteSkip: () => false,
    appendActivity: (line) => activity.push(line),
    outgoing: { enqueue: (fn) => fn(), whenIdle: async () => {} },
    sendLedger: { shouldSkip: () => false, note: () => {} },
    getMessageMediaStore: () => mediaStore,
    getSocialV2: () => ({ conversations }),
  };
  Object.assign(base, overrides);
  return { svc: createSendPipeline(base), sent, notices, activity, mediaStore, conversations, state };
}

test('mediaHintFor：reserved2 带工具句柄，其他模式只给事实', () => {
  const h = ctx();
  h.state.mode = 'reserved2';
  assert.match(h.svc.mediaHintFor('group:1', 'm1', [{ kind: 'image' }]), /qq_get_message_images/);
  h.state.mode = 'chat';
  assert.doesNotMatch(h.svc.mediaHintFor('group:1', 'm1', [{ kind: 'image' }]), /qq_get_message_images/);
  assert.equal(h.svc.mediaHintFor('group:1', '', [{ kind: 'image' }]), '');
});

test('findMessageMedia：reserved2 从 recent/unread 找，普通模式从 mediaStore 找', () => {
  const h = ctx();
  h.state.mode = 'reserved2';
  h.state.st = { recentMessages: [{ messageId: 'm1', media: [{ kind: 'image' }] }], unread: [] };
  assert.deepEqual(h.svc.findMessageMedia('group:1', 'm1'), [{ kind: 'image' }]);
  h.state.mode = 'chat';
  h.mediaStore.set('group:1', new Map([['m2', [{ kind: 'sticker' }]]]));
  assert.deepEqual(h.svc.findMessageMedia('group:1', 'm2'), [{ kind: 'sticker' }]);
  assert.deepEqual(h.svc.findMessageMedia('group:1', 'none'), []);
});

test('clampGapV2：夹在 min/max 之间', () => {
  const h = ctx();
  const cfg = { burstIntervalMinMs: 300, maxGapMs: 10000 };
  assert.equal(h.svc.clampGapV2(50, cfg), 300);
  assert.equal(h.svc.clampGapV2(99999, cfg), 10000);
  assert.equal(h.svc.clampGapV2(1234, cfg), 1234);
});

test('computeGapsV2：fixed/byLength 条数正确', () => {
  const h = ctx();
  const cfg = { burstIntervalMinMs: 300, maxGapMs: 10000, gapBaseMs: 800, gapPerCharMs: 20 };
  assert.deepEqual(h.svc.computeGapsV2(['a'], 'fixed', 1000, [], cfg), []);
  assert.deepEqual(h.svc.computeGapsV2(['a', 'b', 'c'], 'fixed', 1000, [], cfg), [1000, 1000]);
  assert.deepEqual(h.svc.computeGapsV2(['aa', 'bb'], 'byLength', 0, [], cfg), [840]);
});

test('shouldAuditKey：closed-agent 只跳过 owner 私聊', () => {
  const h = ctx();
  h.state.mode = 'closed-agent';
  assert.equal(h.svc.shouldAuditKey('private:123'), false);
  assert.equal(h.svc.shouldAuditKey('private:456'), true);
  h.state.mode = 'chat';
  assert.equal(h.svc.shouldAuditKey('private:123'), true);
});

test('auditAndSend：敏感文本/已知 token 拦截，普通文本发送', async () => {
  const h = ctx();
  assert.equal(await h.svc.auditAndSend('group:1', 'C:\\secret\\file.txt'), false);
  assert.equal(h.sent.length, 0);
  assert.match(h.notices[0][1], /拦截/);

  rememberAgentToken('group:1', 'tok-abcdef');
  assert.equal(await h.svc.auditAndSend('group:1', '我的令牌是 tok-abcdef'), false);
  forgetAgentToken('group:1');

  assert.equal(await h.svc.auditAndSend('group:1', '正常回复'), true);
  assert.deepEqual(h.sent.at(-1), ['group:1', '正常回复']);
});
