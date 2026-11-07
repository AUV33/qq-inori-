import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../src/domain/conversation/session-mailbox.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('同 key 严格串行：按入队顺序完成', async () => {
  const order = [];
  await Promise.all([
    run('k', async () => { await delay(10); order.push('a'); }),
    run('k', async () => { order.push('b'); }),
    run('k', async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('不同 key 并行：不互相阻塞', async () => {
  const log = [];
  await Promise.all([
    run('a', async () => { await delay(15); log.push('a-done'); }),
    run('b', async () => { await delay(1); log.push('b-done'); }),
  ]);
  // b 先完成（delay 更短），说明 a 的 15ms 没有阻塞 b —— 两会话并行
  assert.deepEqual(log, ['b-done', 'a-done']);
});

test('失败不中断邮箱：前项 reject 后续仍执行', async () => {
  const done = [];
  await run('k', async () => { throw new Error('boom'); }).catch(() => {});
  await run('k', async () => { done.push('second'); });
  assert.deepEqual(done, ['second']);
});

test('空 key 退化为直接执行', async () => {
  let ran = false;
  await run(null, async () => { ran = true; });
  assert.equal(ran, true);
});
