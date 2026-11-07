// reply-target-service 金标：引用解析的归属校验、seq→messageId 映射、导出面完整性。
// 2026-11-02 回归：isQuoteTargetOwner / isQuoteTargetSelf 定义在工厂里却没进返回值，
// app.mjs 的 message-intake 依赖直接引用这两个名字 → getMessageIntake() 一执行就 ReferenceError。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyTarget } from '../src/domain/conversation/reply-target-service.mjs';

function makeCtx(overrides = {}) {
  const calls = { getMessage: [] };
  const bot = {
    getMessage: async (id) => {
      calls.getMessage.push(id);
      const hit = overrides.messages?.[String(id)];
      return hit ?? null;
    },
  };
  const ctx = {
    log: () => {},
    getBot: () => bot,
    cleanMemberName: (name) => String(name ?? '').replace(/@/g, ''),
    segmentsToText: async (segs) => segs.map((s) => s?.data?.text ?? '').join(''),
    resolveGroupMemberName: async () => '群友A',
    ...overrides,
  };
  return { svc: createReplyTarget(ctx), calls };
}

test('导出面：message-intake 依赖的四个函数 + 两个引用判定都要在', () => {
  const { svc } = makeCtx();
  for (const name of ['pruneReplyInfoCache', 'resolveReplyInfo', 'resolveReplyTargetV2', 'firstReplyId', 'isQuoteTargetOwner', 'isQuoteTargetSelf']) {
    assert.equal(typeof svc[name], 'function', `${name} 必须在返回值里`);
  }
});

test('resolveReplyInfo：群引用必须归属本群，跨群/缺归属一律拒绝', async () => {
  const { svc } = makeCtx({
    messages: {
      11: { group_id: 999, sender: { card: '别人', user_id: 5 }, message: [{ type: 'text', data: { text: '你好' } }] },
      12: { sender: { card: '无群号', user_id: 5 }, message: [] },
      13: { group_id: 123456789, sender: { nickname: '群友A', user_id: 7 }, message: [{ type: 'text', data: { text: '在的' } }] },
    },
  });
  assert.equal(await svc.resolveReplyInfo('group', 123456789, 11), null, '别的群的消息不能读');
  assert.equal(await svc.resolveReplyInfo('group', 123456789, 12), null, '缺 group_id 视为无法确认归属');
  const ok = await svc.resolveReplyInfo('group', 123456789, 13);
  assert.deepEqual(ok, { sender: '群友A', text: '在的', userId: '7' });
});

test('resolveReplyInfo：私聊引用必须无群归属且发送者匹配（self 例外）', async () => {
  const { svc } = makeCtx({
    messages: {
      21: { group_id: 123, sender: { user_id: 9 }, message: [] },
      22: { sender: { user_id: 9 }, message: [{ type: 'text', data: { text: 'x' } }] },
      23: { sender: { user_id: 42 }, message: [{ type: 'text', data: { text: '自己' } }] },
    },
  });
  assert.equal(await svc.resolveReplyInfo('private', 555, 21), null, '群消息不能当私聊引用');
  assert.equal(await svc.resolveReplyInfo('private', 555, 22), null, '发送者不是本人');
  assert.ok(await svc.resolveReplyInfo('private', 555, 22, 9), 'selfId 命中时放行（自己发过的消息）');
  assert.ok(await svc.resolveReplyInfo('private', 555, 23, 42));
});

test('resolveReplyInfo：超安全整数的 id 直接拒绝，且负缓存 5 秒内不再打网关', async () => {
  const { svc, calls } = makeCtx();
  assert.equal(await svc.resolveReplyInfo('group', 1, '9007199254740993'), null);
  assert.equal(calls.getMessage.length, 0, '非法 id 不该打网关');
  assert.equal(await svc.resolveReplyInfo('group', 1, '9007199254740993'), null, '第二次命中负缓存');
});

test('resolveReplyTargetV2：本地 seq 优先映射真实 messageId，取不到就用本地文本兜底', async () => {
  const st = {
    recentMessages: [
      { seq: 41, messageId: 7001, sender: '群友A', text: '原先的话' },
      { seq: 42, messageId: 7002, sender: '群友B', plain: '网关查不到就用本地文本' },
    ],
  };
  const { svc } = makeCtx({
    messages: { 7001: { group_id: 1, sender: { card: '群友A', user_id: 3 }, message: [{ type: 'text', data: { text: '原始内容' } }] } },
  });
  const hit = await svc.resolveReplyTargetV2(st, 'group', 1, '41');
  assert.equal(hit.messageId, '7001');
  assert.deepEqual(hit.info, { sender: '群友A', text: '原始内容', userId: '3' });

  const fallback = await svc.resolveReplyTargetV2(st, 'group', 1, '42');
  assert.equal(fallback.messageId, '7002', '网关没返回时用本地记录兜底，但 id 仍映射到真实 messageId');
  assert.equal(fallback.info.text, '网关查不到就用本地文本');
  assert.equal(fallback.info.sender, '群友B');

  assert.equal(await svc.resolveReplyTargetV2(st, 'group', 1, '9999'), null, '查不到也没有本地记录 → null');
  assert.equal(await svc.resolveReplyTargetV2(st, 'group', 1, ''), null);
});

test('isQuoteTargetOwner / isQuoteTargetSelf：按引用消息的发送者判定', async () => {
  const { svc } = makeCtx({
    messages: {
      31: { group_id: 1, sender: { user_id: 10001 }, message: [] },
      32: { group_id: 1, sender: { user_id: 999 }, message: [] },
    },
  });
  const quote = (id) => [{ type: 'reply', data: { id: String(id) } }];
  assert.equal(await svc.isQuoteTargetOwner(quote(31), 'group', 1, 10001), true);
  assert.equal(await svc.isQuoteTargetOwner(quote(32), 'group', 1, 10001), false);
  assert.equal(await svc.isQuoteTargetOwner(quote(31), 'group', 1, null), false, '没有 ownerQQ 时直接 false');
  assert.equal(await svc.isQuoteTargetSelf(quote(32), 'group', 1, 999), true);
  assert.equal(await svc.isQuoteTargetSelf([], 'group', 1, 999), false);
});

test('firstReplyId：只认 reply 段里的 id', () => {
  const { svc } = makeCtx();
  assert.equal(svc.firstReplyId([{ type: 'text', data: {} }, { type: 'reply', data: { id: 88 } }]), 88);
  assert.equal(svc.firstReplyId([{ type: 'reply', data: {} }]), null);
  assert.equal(svc.firstReplyId(null), null);
});
