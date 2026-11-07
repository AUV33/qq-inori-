import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runIsolated, recoverMailbox, recoverAll, setCrashHandler,
  crashedKeys, orphanCount,
} from '../src/domain/conversation/session-mailbox.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('M5: 单会话抛错只隔离自己，其他会话继续', async () => {
  await recoverAll(); // 清理跨测试残留
  setCrashHandler(null);
  const log = [];
  await runIsolated('A', async () => { throw new Error('boom-A'); });
  await runIsolated('B', async () => { log.push('B-ran'); });
  assert.deepEqual(crashedKeys(), ['A']); // 只有 A 崩溃
  assert.deepEqual(log, ['B-ran']);       // B 正常执行，不受 A 影响
});

test('M5: 崩溃会话暂停自动消费，新事件暂存为孤儿，恢复后重放', async () => {
  await recoverAll();
  setCrashHandler(null);
  await runIsolated('A', async () => { throw new Error('boom'); });
  // 崩溃后新事件不立即执行，而是暂存
  let ran = false;
  const p = runIsolated('A', async () => { ran = true; });
  await delay(20);
  assert.equal(ran, false, '崩溃会话的新事件不应立即执行');
  assert.equal(orphanCount('A'), 1, '新事件应暂存为孤儿');
  // 恢复后重放
  await recoverMailbox('A');
  await p;
  assert.equal(ran, true, '恢复后孤儿事件被重放');
  assert.deepEqual(crashedKeys(), [], '恢复后不再处于崩溃态');
});

test('M5: 崩溃会话 recover 后可继续处理新事件', async () => {
  await recoverAll();
  setCrashHandler(null);
  await runIsolated('A', async () => { throw new Error('x'); });
  await recoverMailbox('A');
  let ran = false;
  await runIsolated('A', async () => { ran = true; });
  assert.equal(ran, true);
});

test('M5: recoverAll 恢复所有崩溃桶', async () => {
  await recoverAll();
  setCrashHandler(null);
  await runIsolated('X', async () => { throw new Error('x'); });
  await runIsolated('Y', async () => { throw new Error('y'); });
  assert.deepEqual([...crashedKeys()].sort(), ['X', 'Y']);
  await recoverAll();
  assert.deepEqual(crashedKeys(), []);
});

test('M5: 崩溃回调被调用（可挂自动恢复 / 告警）', async () => {
  let captured = null;
  setCrashHandler((key, err) => { captured = { key, msg: err?.message }; });
  await runIsolated('Z', async () => { throw new Error('z-boom'); });
  assert.equal(captured?.key, 'Z');
  assert.equal(captured?.msg, 'z-boom');
  setCrashHandler(null);
});

test('M5: 双会话并发且各自独立崩溃/恢复，互不传染', async () => {
  await recoverAll();
  setCrashHandler(null);
  // A 崩溃、B 正常，交错触发
  await Promise.all([
    runIsolated('A', async () => { throw new Error('A-down'); }),
    runIsolated('B', async () => { await delay(10); }),
  ]);
  assert.deepEqual(crashedKeys(), ['A']);
  // B 在 A 崩溃期间仍正常推进
  let bRan = false;
  await runIsolated('B', async () => { bRan = true; });
  assert.equal(bRan, true);
  // 恢复 A，A 后续事件可执行
  await recoverMailbox('A');
  let aRan = false;
  await runIsolated('A', async () => { aRan = true; });
  assert.equal(aRan, true);
});
