import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutgoingQueue } from '../src/domain/send/outgoing-queue.mjs';

test('串行：后入队的任务必须等前一个结束（先文字后表情的顺序保证）', async () => {
  const queue = createOutgoingQueue();
  const order = [];
  let release;
  const first = queue.enqueue(async () => {
    order.push('a:start');
    await new Promise((resolve) => { release = resolve; });
    order.push('a:end');
  });
  const second = queue.enqueue(async () => { order.push('b'); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['a:start'], '第二个任务不许插队');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
});

test('失败隔离：一个任务抛错不阻断后续任务，错误交给 onError', async () => {
  const errors = [];
  const queue = createOutgoingQueue({ onError: (error) => errors.push(error.message) });
  const bad = queue.enqueue(async () => { throw new Error('发送失败'); });
  const good = queue.enqueue(async () => 'ok');
  await assert.rejects(bad, /发送失败/);
  assert.equal(await good, 'ok');
  assert.deepEqual(errors, ['发送失败']);
});

test('返回值：enqueue 能拿到任务结果；不 await 也不会 unhandledRejection', async () => {
  const queue = createOutgoingQueue();
  assert.equal(await queue.enqueue(() => 42), 42);
  // 故意不 await 一个会失败的任务：挂了 catch 兜底，不应让进程崩
  queue.enqueue(async () => { throw new Error('不 await 的失败'); });
  await queue.whenIdle();
});

test('whenIdle：只等调用时刻已入队的任务，之后入队的不拖住它', async () => {
  const queue = createOutgoingQueue();
  const done = [];
  let release;
  queue.enqueue(async () => { await new Promise((resolve) => { release = resolve; }); done.push('first'); });
  const idle = queue.whenIdle();
  let releaseSecond;
  queue.enqueue(async () => { await new Promise((resolve) => { releaseSecond = resolve; }); done.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 0)); // 让第一个任务真正开始
  release();
  await idle;
  assert.deepEqual(done, ['first'], 'idle 不该等后入队的任务（第二个还卡着）');
  releaseSecond();
  await queue.whenIdle();
  assert.deepEqual(done, ['first', 'second']);
});

test('失败记账：markFailed → succeeded=false；clearFailed/成功一次即恢复', async () => {
  const queue = createOutgoingQueue();
  assert.equal(queue.succeeded('group:1'), true, '没有记录 = 成功');
  queue.markFailed('group:1');
  assert.equal(queue.succeeded('group:1'), false);
  assert.equal(queue.succeeded('group:2'), true, '按 key 记账，不串味');
  queue.clearFailed('group:1');
  assert.equal(queue.succeeded('group:1'), true);
  assert.equal(queue.failedCount(), 0);
});

test('stats：pending 随入队/结束变化，failed 反映失败会话', async () => {
  const queue = createOutgoingQueue();
  let release;
  const first = queue.enqueue(async () => { await new Promise((resolve) => { release = resolve; }); });
  queue.enqueue(async () => 'ok');
  assert.equal(queue.stats().pending, 2);
  queue.markFailed('group:9');
  assert.equal(queue.stats().failed, 1);
  await new Promise((resolve) => setTimeout(resolve, 0)); // 让第一个任务真正开始
  release();
  await queue.whenIdle();
  assert.equal(queue.stats().pending, 0);
  await first;
});

test('key 归一化：数字 key 与字符串 key 是同一个会话', () => {
  const queue = createOutgoingQueue();
  queue.markFailed(1);
  assert.equal(queue.succeeded('1'), false);
});
