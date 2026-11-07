// 行为级测试：pure-utils.mjs（从 app.mjs 拆出的纯工具）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { localClock, sleep, convKey, withTimeout } from '../src/domain/shared/pure-utils.mjs';

test('localClock: 输出 HH:MM:SS 本地时间', () => {
  // 2026-01-02 03:04:05 UTC → 北京 UTC+8 为 11:04:05
  const s = localClock(Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.match(s, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(s, '11:04:05');
});

test('convKey: 组合会话键', () => {
  assert.equal(convKey('group', 42), 'group:42');
  assert.equal(convKey('private', 7), 'private:7');
});

test('sleep: 至少等待给定毫秒', async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 18); // 允许调度抖动
});

test('withTimeout: 快速 promise 正常 resolve', async () => {
  const r = await withTimeout(Promise.resolve('ok'), 50, 'fast');
  assert.equal(r, 'ok');
});

test('withTimeout: 超时 reject 并带标签', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 100));
  await assert.rejects(
    withTimeout(slow, 20, 'slow-op'),
    (e) => /slow-op/.test(e.message) && /超时/.test(e.message)
  );
});
