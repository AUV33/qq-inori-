import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeartbeatWatch } from '../src/onebot/heartbeat.mjs';

test('从未收到心跳时不判超时（不发心跳的实现不能被误杀）', () => {
  let fired = 0;
  const watch = createHeartbeatWatch({ timeoutMs: 1000, onTimeout: () => { fired += 1; } });
  const result = watch.check(999_999);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'no-heartbeat');
  assert.equal(fired, 0);
});

test('心跳在阈值内返回 ok，超过阈值只回调一次', () => {
  let nowMs = 10_000;
  let fired = 0;
  const watch = createHeartbeatWatch({
    timeoutMs: 1000,
    now: () => nowMs,
    onTimeout: (info) => { fired += 1; assert.equal(info.reason, 'timeout'); },
  });
  watch.noteHeartbeat(300);
  assert.equal(watch.check().ok, true);

  nowMs += 1001;
  const timeout = watch.check();
  assert.equal(timeout.ok, false);
  assert.equal(timeout.reason, 'timeout');
  assert.equal(fired, 1);

  // 同一个时刻再检查：基准已挪到超时时刻，不应连续触发
  assert.equal(watch.check().ok, true);
  assert.equal(fired, 1);
  assert.equal(watch.stats().timeouts, 1);
});

test('OneBot 报的 interval 比配置阈值大时，按 interval×3 放宽', () => {
  let nowMs = 0;
  const watch = createHeartbeatWatch({ timeoutMs: 1000, now: () => nowMs });
  watch.noteHeartbeat(60_000);
  nowMs = 120_000; // 配置阈值 1s 早过了，但 interval 60s 的 3 倍是 180s
  assert.equal(watch.check().ok, true);
  nowMs = 180_001;
  assert.equal(watch.check().ok, false);
  assert.equal(watch.stats().effectiveTimeoutMs, 180_000);
});

test('连接断开时跳过检查，不跟 SDK 的重连抢', () => {
  let nowMs = 0;
  let fired = 0;
  const watch = createHeartbeatWatch({
    timeoutMs: 1000,
    now: () => nowMs,
    isConnected: () => false,
    onTimeout: () => { fired += 1; },
  });
  watch.noteHeartbeat(300);
  nowMs = 5000;
  const result = watch.check();
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'disconnected');
  assert.equal(fired, 0);
});

test('reset 后回到“还没见过心跳”的状态', () => {
  let nowMs = 0;
  const watch = createHeartbeatWatch({ timeoutMs: 1000, now: () => nowMs });
  watch.noteHeartbeat(300);
  watch.reset();
  assert.equal(watch.check().skipped, 'no-heartbeat');
  assert.equal(watch.stats().seen, false);
});

test('timeoutMs=0 表示关闭，start 不建定时器、check 直接跳过', () => {
  let scheduled = 0;
  const watch = createHeartbeatWatch({
    timeoutMs: 0,
    setIntervalFn: () => { scheduled += 1; return { unref() {} }; },
  });
  watch.noteHeartbeat(300);
  watch.start();
  assert.equal(scheduled, 0);
  assert.equal(watch.check().skipped, 'disabled');
  assert.equal(watch.stats().timerActive, false);
});

test('start 的定时器回调会执行 check', () => {
  let nowMs = 0;
  let fired = 0;
  let tick = null;
  const watch = createHeartbeatWatch({
    timeoutMs: 1000,
    now: () => nowMs,
    onTimeout: () => { fired += 1; },
    setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
  });
  watch.noteHeartbeat(300);
  watch.start();
  nowMs = 2000;
  tick();
  assert.equal(fired, 1);
  assert.equal(watch.stats().checks, 1);
});

test('start 只建一个定时器，stop 清掉', () => {
  let scheduled = 0;
  let cleared = 0;
  const handle = { unref() {} };
  const watch = createHeartbeatWatch({
    timeoutMs: 1000,
    setIntervalFn: () => { scheduled += 1; return handle; },
    clearIntervalFn: (h) => { assert.equal(h, handle); cleared += 1; },
  });
  watch.start();
  watch.start();
  assert.equal(scheduled, 1);
  assert.equal(watch.stats().timerActive, true);
  watch.stop();
  assert.equal(cleared, 1);
  assert.equal(watch.stats().timerActive, false);
});
