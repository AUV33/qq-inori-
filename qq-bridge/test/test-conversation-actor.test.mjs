// [ACTOR] 会话 actor 的契约：同 key 串行、跨 key 并行、失败不阻塞、销毁语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationActor, createActorRegistry } from '../src/domain/conversation/conversation-actor.mjs';

test('同 key 串行：后一个任务等前一个结束才开始', async () => {
  const order = [];
  const actor = createConversationActor({ key: 'private:1' });
  const t1 = actor.post(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); return 1; });
  const t2 = actor.post(async () => { order.push('b'); return 2; });
  assert.deepEqual(await Promise.all([t1, t2]), [1, 2]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('跨 key 并行：两个 actor 互不阻塞', async () => {
  const a = createConversationActor({ key: 'private:1' });
  const b = createConversationActor({ key: 'group:2' });
  const started = [];
  const slow = a.post(async () => { started.push('a'); await new Promise((r) => setTimeout(r, 30)); });
  const quick = b.post(async () => { started.push('b'); });
  await quick;
  assert.deepEqual(started, ['a', 'b'], 'b 不该等 a');
  await slow;
});

test('失败不阻塞：onError 收到错误，队列继续跑', async () => {
  const errors = [];
  const actor = createConversationActor({ key: 'k', onError: (e) => errors.push(e.message) });
  const bad = actor.post(async () => { throw new Error('boom'); });
  const good = actor.post(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.deepEqual(errors, ['boom']);
  assert.equal(actor.idle(), true);
});

test('post 参数校验：非函数直接拒绝', async () => {
  const actor = createConversationActor({ key: 'k' });
  await assert.rejects(actor.post(null), TypeError);
  assert.equal(actor.pending(), 0);
});

test('dispose：排队任务被拒绝、正在跑的跑完、之后拒绝新任务', async () => {
  const actor = createConversationActor({ key: 'k' });
  const running = actor.post(async () => { await new Promise((r) => setTimeout(r, 20)); return 'done'; });
  const queued = actor.post(async () => 'never');
  const queuedErr = queued.catch((e) => e); // 先挂处理器：dispose 会立刻拒绝排队任务
  actor.dispose();
  assert.equal(await running, 'done');
  assert.match(String((await queuedErr)?.message), /已销毁/);
  await assert.rejects(actor.post(async () => 1), /已销毁/);
});

test('pending/inFlight 计数', async () => {
  const actor = createConversationActor({ key: 'k' });
  let release;
  const running = actor.post(() => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r)); // 任务在微任务里才开始
  assert.equal(actor.inFlight(), 1);
  const q = actor.post(async () => 2);
  assert.equal(actor.pending(), 1);
  release(1);
  await Promise.all([running, q]);
  assert.equal(actor.idle(), true);
});

test('registry：同 key 同一个 actor，disposeAll 清空', () => {
  const reg = createActorRegistry();
  const a1 = reg.get('private:1');
  const a2 = reg.get('private:1');
  const b = reg.get('group:2');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(reg.size(), 2);
  reg.disposeAll();
  assert.equal(reg.size(), 0);
});
