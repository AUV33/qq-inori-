// [MATRIX] bridge-lock.mjs 的直接测试：锁的原子创建/释放与过期锁接管。
// 注意：刻意不构造「另一个存活 PID」的用例——那条分支会 process.exit(2) 终止测试进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createBridgeLock } from '../src/bootstrap/bridge-lock.mjs';

function withTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-bridge-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lockOf = (dir) => path.join(dir, 'bridge.lock');

test('首次 acquireLock 原子建锁并写入自身 PID；releaseLock 删掉自己的锁', (t) => {
  const dir = withTmp(t);
  const lock = createBridgeLock({ STATE_DIR: dir, ROOT: dir });
  lock.acquireLock();
  assert.equal(fs.readFileSync(lockOf(dir), 'utf8').trim(), String(process.pid));
  lock.releaseLock();
  assert.equal(fs.existsSync(lockOf(dir)), false);
  assert.doesNotThrow(() => lock.releaseLock(), '重复释放必须幂等');
});

test('过期锁（空 / 非数字 / 非法 PID）会被接管，不会误杀进程', (t) => {
  for (const content of ['', 'not-a-pid', '0', '-3']) {
    const dir = withTmp(t);
    const file = lockOf(dir);
    fs.writeFileSync(file, content, 'utf8');
    createBridgeLock({ STATE_DIR: dir, ROOT: dir }).acquireLock();
    assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid), `过期锁 ${JSON.stringify(content)} 应被接管`);
  }
});

test('releaseLock 只删 PID 属于自己的锁，不误删别人的锁', (t) => {
  const dir = withTmp(t);
  const file = lockOf(dir);
  fs.writeFileSync(file, String(process.pid + 1), 'utf8');
  createBridgeLock({ STATE_DIR: dir, ROOT: dir }).releaseLock();
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid + 1));
});

test('consolePortInUse 总是返回布尔（探测失败时保守为 true）', (t) => {
  const dir = withTmp(t);
  const lock = createBridgeLock({ STATE_DIR: dir, ROOT: dir });
  assert.equal(typeof lock.consolePortInUse(), 'boolean');
  assert.equal(Object.keys(lock).sort().join(','), 'acquireLock,consolePortInUse,releaseLock');
});

test('锁里是另一个存活进程的 PID 时保守拒绝启动（exit 2）并给出自助恢复提示', (t) => {
  // 这条分支会 process.exit(2)，不能在测试进程里直接调；用子进程把它变成可断言的退出码。
  const dir = withTmp(t);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch { /* 已退出 */ } });
  fs.writeFileSync(lockOf(dir), String(holder.pid), 'utf8');

  const moduleUrl = new URL('../src/bootstrap/bridge-lock.mjs', import.meta.url).href;
  const script = `import { createBridgeLock } from ${JSON.stringify(moduleUrl)};
createBridgeLock({ STATE_DIR: ${JSON.stringify(dir)}, ROOT: ${JSON.stringify(dir)} }).acquireLock();`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.error, undefined, String(r.error ?? ''));
  assert.equal(r.status, 2, `应 fail-closed 退出 2，实际 ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stderr, /bridge\.lock|实例|启动|无法确认/, '拒绝信息要告诉用户怎么自助恢复');
  assert.equal(fs.readFileSync(lockOf(dir), 'utf8').trim(), String(holder.pid),
    '拒绝启动不得删掉别人的锁');
});
