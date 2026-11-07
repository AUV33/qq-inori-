// [LOCK-NONBLOCK] 锁等待必须短且有界：这层跑在主线程，同步等待会卡死事件循环。
//
// 背景：2026-11-07 桥接假死（端口在、HTTP 无响应、心跳停），日志停在
// 「保存 socialV2 分片失败 … 学习数据文件锁等待超时」。当时 LOCK_TIMEOUT_MS=3000，
// 每次保存抢不到锁就阻塞主线程 3 秒；消息一密，定时器全部饿死。
// 现在上限 100ms，并且 EPERM 不再被误判成「进程已死」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  withFileLock,
  writeJsonDocument,
} from '../../ai-companion-kit/packages/shared/learning-store.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
process.env.LEARNING_TREND = path.join(tmp, 'trend.jsonl');
const target = path.join(tmp, 'target.json');
const lock = `${path.resolve(target)}.lock`;

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('锁被活进程持有时：快速失败（<600ms），不阻塞主线程', () => {
  fs.writeFileSync(lock, `${process.pid} ${Date.now()}`, 'utf8');
  const started = Date.now();
  const r = withFileLock(target, () => ({ ok: true }), { source: 'test' });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false, '拿不到锁必须返回 ok:false，而不是假装写成功');
  assert.ok(elapsed < 600, `同步等待应 ≤100ms 量级，实际 ${elapsed}ms`);
  assert.match(String(r.error), /锁等待超时/);
  fs.rmSync(lock, { force: true });
});

test('陈旧锁（PID 已死）：自动清掉并写入成功', () => {
  fs.writeFileSync(lock, `999999 ${Date.now() - 60_000}`, 'utf8');
  const r = writeJsonDocument(target, { a: 1 }, { source: 'test' });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).a, 1);
  assert.equal(fs.existsSync(lock), false, '写完必须释放锁');
});

test('锁路径按绝对路径归一：同一文件的相对/绝对写法不会自锁', () => {
  fs.writeFileSync(lock, `${process.pid} ${Date.now()}`, 'utf8');
  // 用相对路径再拿一次锁：若 lockPath 不归一，会得到另一个 .lock 并错误地「成功」
  const rel = path.relative(process.cwd(), target);
  const r = withFileLock(rel, () => ({ ok: true }), { source: 'test' });
  assert.equal(r.ok, false, '同一文件的不同写法必须命中同一把锁');
  fs.rmSync(lock, { force: true });
});
