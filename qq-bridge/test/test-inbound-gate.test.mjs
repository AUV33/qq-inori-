import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboundGate, pokeDedupeKey } from '../src/onebot/inbound-gate.mjs';

function privateEvent(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 20002,
    message_id: 30003,
    message: [{ type: 'text', data: { text: '在吗' } }],
    ...overrides,
  };
}

function groupEvent(overrides = {}) {
  return privateEvent({
    message_type: 'group',
    group_id: 40004,
    message_id: 50005,
    ...overrides,
  });
}

test('接受合法的私聊和群消息', () => {
  const gate = createInboundGate();
  assert.deepEqual(gate.accept(privateEvent()), { ok: true, deduped: true, key: '10001:private:-:30003' });
  assert.deepEqual(gate.accept(groupEvent()), { ok: true, deduped: true, key: '10001:group:40004:50005' });
  assert.equal(gate.stats().accepted, 2);
});

test('message_sent 回显和非 message 事件被挡下', () => {
  const gate = createInboundGate();
  assert.equal(gate.accept(privateEvent({ post_type: 'message_sent' })).reason, 'malformed');
  assert.equal(gate.accept(privateEvent({ post_type: 'notice' })).reason, 'malformed');
  assert.equal(gate.stats().malformed, 2);
});

test('缺字段的事件被挡下，不进入业务层', () => {
  const gate = createInboundGate();
  for (const event of [
    null,
    [],
    privateEvent({ self_id: undefined }),
    privateEvent({ user_id: '' }),
    privateEvent({ message: undefined }),
    groupEvent({ group_id: undefined }),
    privateEvent({ message_type: 'discuss' }),
  ]) {
    assert.equal(gate.accept(event).reason, 'malformed', JSON.stringify(event));
  }
});

test('同一个 message_id 第二次被识别为重复', () => {
  const gate = createInboundGate();
  assert.equal(gate.accept(privateEvent()).ok, true);
  const duplicate = gate.accept(privateEvent());
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.key, '10001:private:-:30003');
  assert.equal(gate.stats().duplicates, 1);
});

test('同一个 message_id 出现在不同群/不同账号时不互相吞掉', () => {
  const gate = createInboundGate();
  assert.equal(gate.accept(groupEvent({ group_id: 40004 })).ok, true);
  assert.equal(gate.accept(groupEvent({ group_id: 40005 })).ok, true);
  assert.equal(gate.accept(groupEvent({ self_id: 10002 })).ok, true);
});

test('没有 message_id 时不猜、不去重，连续两条都放行', () => {
  const gate = createInboundGate();
  const event = privateEvent({ message_id: undefined });
  assert.deepEqual(gate.accept(event), { ok: true, deduped: false });
  assert.deepEqual(gate.accept(event), { ok: true, deduped: false });
});

test('超过 TTL 后同一个 id 可以再次通过（防止 id 复用被永久吞掉）', () => {
  let nowMs = 1_000_000;
  const gate = createInboundGate({ ttlMs: 1000, now: () => nowMs });
  assert.equal(gate.accept(privateEvent()).ok, true);
  nowMs += 1001;
  assert.equal(gate.accept(privateEvent()).ok, true);
});

test('message_id=0 视为没有 id，不拿它当幂等键把整段会话吞掉', () => {
  const gate = createInboundGate();
  const zero = privateEvent({ message_id: 0, message_seq: undefined });
  assert.equal(gate.accept(zero).ok, true);
  assert.equal(gate.accept(zero).ok, true);
  const zeroString = privateEvent({ message_id: '0', message_seq: undefined });
  assert.equal(gate.accept(zeroString).ok, true);
  assert.equal(gate.accept(zeroString).ok, true);
});

test('message_id=0 但 message_seq 有效时，用 seq 去重', () => {
  const gate = createInboundGate();
  const event = privateEvent({ message_id: 0, message_seq: 42 });
  assert.equal(gate.accept(event).ok, true);
  assert.equal(gate.accept(event).reason, 'duplicate');
});

test('pokeDedupeKey：同一拍一拍稳定，不同时间/目标不同；非 poke 或缺时间返回空', () => {
  const base = { self_id: 1, notice_type: 'notify', sub_type: 'poke', time: 100, group_id: 2, sender_id: 3, target_id: 1, action: '拍了拍' };
  assert.equal(pokeDedupeKey(base), 'notice:1:notify:poke:100:2:3:1:拍了拍:');
  assert.equal(pokeDedupeKey({ ...base }), pokeDedupeKey(base));
  assert.notEqual(pokeDedupeKey({ ...base, time: 101 }), pokeDedupeKey(base));
  assert.notEqual(pokeDedupeKey({ ...base, target_id: 4 }), pokeDedupeKey(base));
  assert.equal(pokeDedupeKey({ ...base, sub_type: 'lucky_king' }), '');
  assert.equal(pokeDedupeKey({ ...base, time: undefined }), '');
});

test('acceptKey 复用同一张幂等表，空 key 放行不去重', () => {
  const gate = createInboundGate();
  assert.equal(gate.acceptKey('notice:poke:1').ok, true);
  assert.equal(gate.acceptKey('notice:poke:1').reason, 'duplicate');
  assert.equal(gate.acceptKey('').ok, true);
  assert.equal(gate.stats().duplicates, 1);
});

test('dedupe:false 时仍做形状校验，但不按 message_id 去重', () => {
  const gate = createInboundGate({ dedupe: false });
  assert.equal(gate.accept(privateEvent()).ok, true);
  assert.equal(gate.accept(privateEvent()).ok, true);
  assert.equal(gate.accept(privateEvent({ user_id: undefined })).reason, 'malformed');
  assert.equal(gate.stats().duplicates, 0);
});

test('有界 LRU：超过 maxSeen 后最旧的一条被淘汰', () => {
  const gate = createInboundGate({ maxSeen: 2 });
  assert.equal(gate.accept(privateEvent({ message_id: 1 })).ok, true);
  assert.equal(gate.accept(privateEvent({ message_id: 2 })).ok, true);
  assert.equal(gate.accept(privateEvent({ message_id: 3 })).ok, true);
  assert.equal(gate.stats().size, 2);
  assert.equal(gate.accept(privateEvent({ message_id: 1 })).ok, true);
});
