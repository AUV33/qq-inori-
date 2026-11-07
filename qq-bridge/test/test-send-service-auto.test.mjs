// send-service(.mjs) 金标：自动转发的剥引号/去重/分条/失败记账/禁言跳过，分批发送与通知抑制。
// 注意：test-send-service.test.mjs 测的是旧的 send-service.js（限频纯函数），两回事。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendService } from '../src/domain/send/send-service.mjs';

function makeCtx(overrides = {}) {
  const state = { sent: [], logs: [], undelivered: [], ledger: [], failed: [], inputStatus: [], autoAck: 0, slept: [] };
  let chain = Promise.resolve();
  const outgoing = {
    enqueue: (fn) => { chain = chain.then(() => fn()); return chain; },
    whenIdle: () => chain,
    markFailed: (key) => { state.failed.push(key); },
    clearFailed: () => {},
    // 真实实现里 succeeded 由队列在失败时清掉，这里跟着 markFailed 走
    succeeded: (key) => !state.failed.includes(key) && (overrides.lastOk === undefined ? true : overrides.lastOk),
  };
  const svc = createSendService({
    cfg: { sendDelayMs: 0, socialV2: { send: { maxMessageChars: 5 } } },
    log: (...args) => state.logs.push(args.map(String).join(' ')),
    knownAgentTokens: new Set(['secret-token']),
    captureSendGuard: () => () => { state.guarded = true; },
    stripSelfQuoting: (s) => String(s).replace(/^「(.+)」$/, '$1'),
    sendLedger: {
      shouldSkip: (key, text) => (overrides.skipText ? overrides.skipText === text : false),
      note: (key, text) => state.ledger.push({ key, text }),
    },
    splitForQQ: (text, max) => {
      const out = [];
      for (let i = 0; i < String(text).length; i += max) out.push(String(text).slice(i, i + max));
      return out.length ? out : [''];
    },
    getOutgoing: () => outgoing,
    withTimeout: async (p) => p,
    getBot: () => ({
      sendPrivateMessage: async (id, msg) => { state.sent.push({ kind: 'private', id, msg }); return {}; },
      sendGroupMessage: async (id, msg) => {
        if (overrides.sendFails) throw new Error('网关拒绝');
        state.sent.push({ kind: 'group', id, msg });
        return {};
      },
      getLoginInfo: async () => ({ user_id: 999 }),
      getGroupMemberInfo: async () => (overrides.muteUntil ? { shut_up_timestamp: Math.floor(overrides.muteUntil / 1000) } : {}),
    }),
    escapeCqText: (s) => s,
    text: (s) => ({ type: 'text', data: { text: s } }),
    appendUndelivered: (row) => state.undelivered.push(row),
    undeliveredFile: 'undelivered.jsonl',
    sleep: async (ms) => { state.slept.push(ms); },
    getSocialV2State: () => (state.conv ??= { metrics: { sends: 0, sendsUndirected: 0 } }),
    getAutoAckAfterSend: () => () => { state.autoAck += 1; },
    relevanceCos: async () => (overrides.cos ?? { cos: 0.9 }),
    getSetInputStatus: () => (id, on) => state.inputStatus.push({ id, on }),
    randInt: (a) => a,
    redactKnownTokensOnly: (s) => String(s).replace(/secret-token/g, '***'),
    SEND_TIMEOUT_MS: 15000,
    ...overrides,
  });
  return { svc, state };
}

test('sendToQQ：剥掉整句自我括号后发送；剥完为空就丢弃', async () => {
  const h = makeCtx();
  await h.svc.sendToQQ('group:1', '「你好」');
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.sent[0].msg.data.text, '你好');

  const empty = makeCtx({ stripSelfQuoting: () => '' });
  await empty.svc.sendToQQ('group:1', '「只有括号」');
  assert.equal(empty.state.sent.length, 0);
  assert.ok(empty.state.logs.some((l) => l.includes('剥完为空')));
});

test('sendToQQ：quoteFix=false 时不替她改字', async () => {
  const h = makeCtx({ cfg: { sendDelayMs: 0, socialV2: { send: { quoteFix: false, maxMessageChars: 50 } } } });
  await h.svc.sendToQQ('group:1', '「留着」');
  assert.equal(h.state.sent[0].msg.data.text, '「留着」');
});

test('sendToQQ：令牌要脱敏；LEDGER 里已发过的整句要跳过', async () => {
  const h = makeCtx({ cfg: { sendDelayMs: 0, socialV2: { send: { maxMessageChars: 50 } } } });
  await h.svc.sendToQQ('group:1', 'abcsecret-token');
  assert.equal(h.state.sent[0].msg.data.text, 'abc***');

  const dup = makeCtx({ skipText: '重复的话' });
  await dup.svc.sendToQQ('group:1', '重复的话');
  assert.equal(dup.state.sent.length, 0);
  assert.ok(dup.state.logs.some((l) => l.includes('[dedupe]')));
});

test('sendToQQ：按 maxMessageChars 分条，全部真发出去才记账并自动确认', async () => {
  const h = makeCtx();
  await h.svc.sendToQQ('group:1', '一二三四五六七八九十一二');
  assert.equal(h.state.sent.length, 3);
  assert.equal(h.state.ledger.length, 3, '每一条发成功都记账');
  assert.equal(h.state.conv.metrics.sends, 1);
  assert.equal(h.state.conv.sentAfterWake, true);
  assert.equal(h.state.autoAck, 1, '全部成功才自动确认已读');
});

test('sendToQQ：发送失败要 markFailed + 落未送达 + 不记账、不自动确认', async () => {
  const h = makeCtx({ sendFails: true });
  await h.svc.sendToQQ('group:1', '发不出去');
  assert.equal(h.state.ledger.length, 0, '失败不能留下「已发」记录');
  assert.ok(h.state.failed.includes('group:1'));
  assert.equal(h.state.undelivered.length, 1);
  assert.equal(h.state.autoAck, 0);
  assert.ok(h.state.logs.some((l) => l.includes('QQ 发送失败')));
});

test('sendToQQ：群被禁言就跳过投递（不撞 result=120），并 markFailed', async () => {
  const h = makeCtx({ muteUntil: Date.now() + 600000 });
  await h.svc.sendToQQ('group:1', '禁言期间的话');
  assert.equal(h.state.sent.length, 0);
  assert.ok(h.state.failed.includes('group:1'));
  assert.ok(h.state.logs.some((l) => l.includes('[mute]')));
});

test('sendNotice：群里不投递系统提示（只记日志），私聊照发', async () => {
  const h = makeCtx();
  await h.svc.sendNotice('group:1', 'agent 出错了');
  assert.equal(h.state.sent.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes('[notice-suppressed]')));
  await h.svc.sendNotice('private:1', '出错');
  assert.equal(h.state.sent.length, 1, '私聊照发');
});

test('sendBurstToQQ：按条投递、条间有间隔、最后一条后不再 sleep', async () => {
  const h = makeCtx({ cfg: { sendDelayMs: 0, socialV2: { send: { maxMessageChars: 500 } } } });
  const sent = await h.svc.sendBurstToQQ('group:1', ['一', '二', '三'], { burstIntervalMinMs: 100, burstIntervalMaxMs: 100 });
  assert.deepEqual(sent, ['一', '二', '三']);
  assert.equal(h.state.sent.length, 3);
  assert.equal(h.state.slept.filter((ms) => ms === 100).length, 2, '三条之间只睡两次');
});

test('sendBurstToQQ：失败也 markFailed（否则调用方会以为「我已说过话」）', async () => {
  const h = makeCtx({ sendFails: true, cfg: { sendDelayMs: 0 } });
  const sent = await h.svc.sendBurstToQQ('group:1', ['一'], 0, 0);
  assert.deepEqual(sent, []);
  assert.ok(h.state.failed.includes('group:1'));
  assert.equal(h.state.undelivered.length, 1);
});

test('sendBurstToQQ：私聊整批前后切换「正在输入」', async () => {
  const h = makeCtx({ cfg: { sendDelayMs: 0 } });
  await h.svc.sendBurstToQQ('private:10001', ['一'], 0, 0);
  assert.deepEqual(h.state.inputStatus, [{ id: 10001, on: true }, { id: 10001, on: false }]);
});

test('sendGuardCheckV2：群里的低相关/无人叫只记录不拦截；私聊与短句直接放过', async () => {
  const h = makeCtx({ cos: { cos: 0.1 } });
  const st = { lastWakeReason: 'probability:0.3', recentMessages: [{ text: '别的话' }, { text: '另一句' }] };
  const r = await h.svc.sendGuardCheckV2('group:1', '这是一句要发的话', st);
  assert.equal(r.ok, true);
  assert.ok(h.state.logs.some((l) => l.includes('没人叫她') && l.includes('只记录，不拦')));

  assert.equal((await h.svc.sendGuardCheckV2('private:1', '这是一句要发的话', st)).ok, true);
  assert.equal((await h.svc.sendGuardCheckV2('group:1', '短', st)).ok, true);
  assert.equal(h.state.logs.filter((l) => l.includes('send-advisory')).length, 1, '短句不记');
});
