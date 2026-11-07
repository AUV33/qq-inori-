// [LOCAL-3B] 闲置清理判断的回归锁：刚起不杀、闲置才杀、重启后按 pid 文件时间判、没 pid 不碰
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSweep, parseNetstatPid, tasklistIsLlamaServer } from '../src/domain/memory/local-3b.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test('刚拉起（内存时间戳新鲜）→ 不杀', () => {
  assert.equal(shouldSweep({ now: NOW, lastSpawnAt: NOW - MIN, idleMs: 10 * MIN, pid: 123 }), false);
});

test('闲置超过阈值 → 杀', () => {
  assert.equal(shouldSweep({ now: NOW, lastSpawnAt: NOW - 11 * MIN, idleMs: 10 * MIN, pid: 123 }), true);
});

test('重启后（时间戳为 0）→ 按 pid 文件 mtime：新鲜不杀', () => {
  assert.equal(shouldSweep({ now: NOW, pidFileMtime: NOW - 2 * MIN, idleMs: 10 * MIN, pid: 123, fromFile: true }), false);
});

test('重启后（时间戳为 0）→ 按 pid 文件 mtime：过期就杀', () => {
  assert.equal(shouldSweep({ now: NOW, pidFileMtime: NOW - 30 * MIN, idleMs: 10 * MIN, pid: 123, fromFile: true }), true);
});

test('没有 pid 或没有阈值 → 永远不杀', () => {
  assert.equal(shouldSweep({ now: NOW, lastSpawnAt: 0, idleMs: 10 * MIN, pid: 0 }), false);
  assert.equal(shouldSweep({ now: NOW, lastSpawnAt: 0, idleMs: 0, pid: 123 }), false);
});

test('parseNetstatPid：从 netstat 输出里认出端口对应 pid（IPv4/IPv6 都行）', () => {
  const out = [
    '  TCP    127.0.0.1:18080        0.0.0.0:0              LISTENING       100900',
    '  TCP    [::1]:8790             [::]:0                 LISTENING       82748',
  ].join(String.fromCharCode(13, 10));
  assert.equal(parseNetstatPid(out, 18080), 100900);
  assert.equal(parseNetstatPid(out, 8790), 82748);
  assert.equal(parseNetstatPid(out, 9999), 0);
});

test('tasklistIsLlamaServer：pid 必须真的对应 llama-server（防 PID 复用杀错）', () => {
  const ok = '"llama-server.exe","100900","Console","1","2,000 K"';
  const other = '"node.exe","100900","Console","1","50,000 K"';
  assert.equal(tasklistIsLlamaServer(ok, 100900), true);
  assert.equal(tasklistIsLlamaServer(other, 100900), false);
  assert.equal(tasklistIsLlamaServer(ok, 999), false);
});
