// 磁盘资源门：只认前缀、只清过期、默认只观察。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TEMP_PREFIX,
  createDiskGuard,
  dirBytes,
  evaluateDiskState,
  listSnapshotDirs,
  removeSnapshotDirs,
  selectStaleDirs,
  summarizeSnapshots,
} from '../src/domain/leaves/inori-disk-guard.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('✅ ' + name);
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'disk-guard-'));
}

function makeDir(root, name, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'objects', '8f'), { recursive: true });
  for (const [file, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'objects', '8f', file), Buffer.alloc(bytes));
  }
  return dir;
}

ok('只列 dsh-workspace-changes- 前缀的目录', () => {
  const root = makeTempRoot();
  makeDir(root, 'dsh-workspace-changes-aaa', { a: 10 });
  makeDir(root, 'other-temp-dir', { b: 10 });
  fs.writeFileSync(path.join(root, 'dsh-workspace-changes-file'), 'x');
  const dirs = listSnapshotDirs({ tempRoot: root });
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].name, 'dsh-workspace-changes-aaa');
  fs.rmSync(root, { recursive: true, force: true });
});

ok('统计目录字节数与汇总', () => {
  const root = makeTempRoot();
  const dir = makeDir(root, 'dsh-workspace-changes-bbb', { a: 100, b: 200 });
  assert.equal(dirBytes(dir).bytes, 300);
  const summary = summarizeSnapshots(listSnapshotDirs({ tempRoot: root }));
  assert.equal(summary.count, 1);
  assert.equal(summary.bytes, 300);
  fs.rmSync(root, { recursive: true, force: true });
});

ok('判级：空间充足为 ok，接近下限为 warn，低于下限为 critical', () => {
  const GB = 1024 ** 3;
  assert.equal(evaluateDiskState({ freeBytes: 100 * GB, totalBytes: 465 * GB, snapshotBytes: 1 * GB }).level, 'ok');
  assert.equal(evaluateDiskState({ freeBytes: 25 * GB, totalBytes: 465 * GB, snapshotBytes: 1 * GB }).level, 'warn');
  assert.equal(evaluateDiskState({ freeBytes: 10 * GB, totalBytes: 465 * GB, snapshotBytes: 1 * GB }).level, 'critical');
});

ok('判级：快照超阈值单独告警，不依赖磁盘空间', () => {
  const GB = 1024 ** 3;
  const warn = evaluateDiskState({ freeBytes: 100 * GB, totalBytes: 465 * GB, snapshotBytes: 13 * GB, maxSnapshotGB: 12 });
  assert.equal(warn.level, 'warn');
  const crit = evaluateDiskState({ freeBytes: 100 * GB, totalBytes: 465 * GB, snapshotBytes: 25 * GB, maxSnapshotGB: 12 });
  assert.equal(crit.level, 'critical');
});

ok('过期判定按 mtime，未超龄的不入选', () => {
  const now = Date.now();
  const dirs = [
    { name: 'a', path: 'x', bytes: 1, mtimeMs: now - 13 * 3600 * 1000 },
    { name: 'b', path: 'y', bytes: 1, mtimeMs: now - 1 * 3600 * 1000 },
  ];
  const stale = selectStaleDirs(dirs, { maxAgeMs: 12 * 3600 * 1000, now });
  assert.deepEqual(stale.map((d) => d.name), ['a']);
});

ok('清理只删前缀目录，路径不符的拒绝', () => {
  const root = makeTempRoot();
  const keep = makeDir(root, 'dsh-workspace-changes-keep', { a: 10 });
  const stale = makeDir(root, 'dsh-workspace-changes-stale', { a: 10 });
  const result = removeSnapshotDirs([
    { name: 'dsh-workspace-changes-stale', path: stale, bytes: 10 },
    { name: 'not-prefixed', path: keep, bytes: 10 },
  ], { tempRoot: root });
  assert.equal(result.removed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(keep), true);
  fs.rmSync(root, { recursive: true, force: true });
});

ok('默认只观察：sample 只报状态，不删任何目录', () => {
  const root = makeTempRoot();
  const dir = makeDir(root, DEFAULT_TEMP_PREFIX + 'obs', { a: 10 });
  const logs = [];
  const guard = createDiskGuard({
    tempRoot: root,
    cleanup: true,
    observeOnly: true,
    log: (line) => logs.push(line),
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 10 }),
  });
  const state = guard.sample();
  assert.equal(state.level, 'critical');
  assert.equal(fs.existsSync(dir), true);
  assert.ok(logs.some((l) => l.includes('[disk]')));
  fs.rmSync(root, { recursive: true, force: true });
});

ok('显式关闭 observeOnly 后才清过期目录', () => {
  const root = makeTempRoot();
  const stale = makeDir(root, DEFAULT_TEMP_PREFIX + 'old', { a: 10 });
  const fresh = makeDir(root, DEFAULT_TEMP_PREFIX + 'new', { a: 10 });
  const old = Date.now() - 13 * 3600 * 1000;
  fs.utimesSync(stale, new Date(old), new Date(old));
  const guard = createDiskGuard({
    tempRoot: root,
    cleanup: true,
    observeOnly: false,
    log: () => {},
    now: () => Date.now(),
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 1000 }),
  });
  const state = guard.sample();
  assert.ok(state.cleaned);
  assert.equal(state.cleaned.count, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(root, { recursive: true, force: true });
});

ok('清理失败不影响守卫，sample 仍返回状态', () => {
  const root = makeTempRoot();
  const boom = makeDir(root, DEFAULT_TEMP_PREFIX + 'boom', { a: 10 });
  const old = Date.now() - 13 * 3600 * 1000;
  fs.utimesSync(boom, new Date(old), new Date(old));
  const guard = createDiskGuard({
    tempRoot: root,
    cleanup: true,
    observeOnly: false,
    log: () => {},
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 1 }),
    remove: () => { throw new Error('locked'); },
  });
  const state = guard.sample();
  assert.equal(state.level, 'critical');
  assert.equal(state.cleaned.failed, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passed} 项通过`);
