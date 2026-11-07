// unread-state 金标：水位只能推进到"展示过/已出缓冲"的位置，引用回复只确认到被引用那条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnreadState } from '../src/domain/conversation/unread-state.mjs';

function makeCtx(overrides = {}) {
  const states = new Map();
  const logs = [];
  let saves = 0;
  const svc = createUnreadState({
    getSocialV2State: (key) => {
      if (!states.has(key)) states.set(key, { unread: [], recentMessages: [], lastUnreadSeq: 0, lastReadThroughSeq: 0, modelSeenSeqs: new Set() });
      return states.get(key);
    },
    saveSocialV2State: () => { saves += 1; },
    log: (m) => logs.push(String(m)),
    ...overrides,
  });
  const get = (key = 'group:1') => svc.constructor && states.get(key);
  return { svc, states, logs, saves: () => saves, get };
}

function seed(h, key, { unread = [], lastUnreadSeq = 0, seen = [], lastReadThroughSeq = 0 } = {}) {
  const st = h.svc.__peek ? null : null;
  const s = h.states.get(key) ?? { unread: [], recentMessages: [], lastUnreadSeq: 0, lastReadThroughSeq: 0, modelSeenSeqs: new Set() };
  h.states.set(key, { ...s, unread, lastUnreadSeq, modelSeenSeqs: new Set(seen), lastReadThroughSeq });
  return h.states.get(key);
}

test('readThroughSeqV2：只看过 seq 1、2 → 水位到 2，第 3 条仍待处理就停住', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], lastUnreadSeq: 3, seen: [1, 2] });
  assert.equal(h.svc.readThroughSeqV2(st), 2);
});

test('readThroughSeqV2：已被缓冲挤掉的下界之前的 seq 视为可达', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 5 }], lastUnreadSeq: 9, seen: [] });
  // 1..4 已不在缓冲里（不可能再展示）→ 水位能推过它们，但停在 4（5 还在缓冲）
  assert.equal(h.svc.readThroughSeqV2(st), 4);
});

test('noteModelMessagesV2：只给缓冲里真实存在的 seq 记回执，旧回执会被裁掉', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 7 }, { seq: 8 }], lastUnreadSeq: 8, seen: [3] });
  const through = h.svc.noteModelMessagesV2(st, [{ seq: 7 }, { seq: 99 }]);
  assert.deepEqual([...st.modelSeenSeqs].sort(), [7], '不在缓冲里的 99 不算看过，历史回执 3 被裁掉');
  assert.equal(through, 7, '1..6 因已被缓冲挤掉而可达，7 是刚记回执的，8 还待处理');
});

test('requestedReadThroughSeqV2：没传 throughSeq 返回 null；非法值抛 400', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 1 }], lastUnreadSeq: 5, seen: [1] });
  assert.equal(h.svc.requestedReadThroughSeqV2(st, {}, true), null);
  for (const bad of [-1, 1.5, 99, '3']) {
    assert.throws(() => h.svc.requestedReadThroughSeqV2(st, { throughSeq: bad }, true), (e) => e.statusCode === 400, String(bad));
  }
  assert.equal(h.svc.requestedReadThroughSeqV2(st, { throughSeq: 1 }, true), 1);
});

test('requestedReadThroughSeqV2：非 agent 调用不能超过 lastUnreadSeq', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 1 }, { seq: 2 }], lastUnreadSeq: 2, seen: [1, 2] });
  assert.throws(() => h.svc.requestedReadThroughSeqV2(st, { throughSeq: 3 }, false), /非负安全整数/);
});

test('acknowledgeMessagesV2：给 null 清空全部；给 seq 只删到那条为止', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], lastUnreadSeq: 3, seen: [1, 2, 3] });
  assert.equal(h.svc.acknowledgeMessagesV2(st, 2), 2);
  assert.deepEqual(st.unread.map((m) => m.seq), [3]);
  assert.equal(st.lastReadThroughSeq, 2);
  const st2 = seed(h, 'group:2', { unread: [{ seq: 1 }, { seq: 2 }], lastUnreadSeq: 2 });
  assert.equal(h.svc.acknowledgeMessagesV2(st2, null), 2);
  assert.deepEqual(st2.unread, []);
  assert.equal(st2.lastReadThroughSeq, 2);
});

test('ackCeilForReply：按 messageId 找到对应 seq；找不到返回 0', () => {
  const h = makeCtx();
  seed(h, 'group:1', { unread: [{ seq: 4, messageId: 400 }, { seq: 5, messageId: 500 }], lastUnreadSeq: 6 });
  assert.equal(h.svc.ackCeilForReply('group:1', 400), 4);
  assert.equal(h.svc.ackCeilForReply('group:1', '500'), 5, 'id 按字符串比');
  assert.equal(h.svc.ackCeilForReply('group:1', 999), 0);
  assert.equal(h.svc.ackCeilForReply('group:1', null), 0);
});

test('autoAckAfterSend：确认 pendingAckSeq，引用较早消息时只到被引用那条', () => {
  const h = makeCtx();
  const st = seed(h, 'group:1', { unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], lastUnreadSeq: 3, seen: [1, 2, 3] });
  st.pendingAckSeq = 3;
  const marked = h.svc.autoAckAfterSend('group:1', 1);
  assert.equal(marked, 1, '引用的是 seq 1 → 只确认 1 条');
  assert.deepEqual(st.unread.map((m) => m.seq), [2, 3], '更新的未读留给下一轮');
  assert.equal(st.pendingAckSeq, 0);
  assert.equal(h.saves(), 1);
});

test('autoAckAfterSend：没有 pending 或抛错都安静返回 0', () => {
  const h = makeCtx();
  seed(h, 'group:1', { unread: [], lastUnreadSeq: 0 });
  assert.equal(h.svc.autoAckAfterSend('group:1'), 0);
  const broken = makeCtx({ getSocialV2State: () => { throw new Error('坏了'); } });
  assert.equal(broken.svc.autoAckAfterSend('group:1'), 0);
  assert.ok(broken.logs.some((l) => l.includes('自动确认失败')));
});
