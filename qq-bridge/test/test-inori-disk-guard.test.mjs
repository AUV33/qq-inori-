// inori-disk-guard 金标：磁盘水位/临时快照的观测与（显式开启时）清理——默认只观察，读不到不误报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TEMP_PREFIX, DEFAULT_THRESHOLDS, dirBytes, listSnapshotDirs, summarizeSnapshots,
  readDiskSpace, evaluateDiskState, selectStaleDirs, removeSnapshotDirs, createDiskGuard,
} from '../src/domain/leaves/inori-disk-guard.js';

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-disk-'));
}

test('dirBytes：递归统计字节与文件数；读不到的子目录跳过', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'x.txt'), '12345');
  fs.writeFileSync(path.join(root, 'a', 'b', 'y.txt'), '123');
  const r = dirBytes(root);
  assert.equal(r.files, 2);
  assert.equal(r.bytes, 8);
  assert.deepEqual(dirBytes(path.join(root, 'nope')), { bytes: 0, files: 0 });
});

test('listSnapshotDirs：只认前缀目录，别的东西不碰；不存在返回空数组', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, `${DEFAULT_TEMP_PREFIX}1`));
  fs.writeFileSync(path.join(root, `${DEFAULT_TEMP_PREFIX}1`, 'obj'), '1234');
  fs.mkdirSync(path.join(root, 'other-dir'));
  fs.writeFileSync(path.join(root, `${DEFAULT_TEMP_PREFIX}file`), 'x');
  const dirs = listSnapshotDirs({ tempRoot: root });
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].name, `${DEFAULT_TEMP_PREFIX}1`);
  assert.equal(dirs[0].bytes, 4);
  assert.ok(dirs[0].mtimeMs > 0);
  assert.deepEqual(listSnapshotDirs({ tempRoot: path.join(root, 'nope') }), []);
});

test('summarizeSnapshots：个数与总字节；非数组安全', () => {
  assert.deepEqual(summarizeSnapshots([{ bytes: 10 }, { bytes: 5 }, {}]), { count: 3, bytes: 15 });
  assert.deepEqual(summarizeSnapshots(null), { count: 0, bytes: 0 });
});

test('readDiskSpace：正常换算；statfs 抛错或 total=0 返回 null（不误报）', () => {
  const ok = readDiskSpace('/x', () => ({ bsize: 4096, blocks: 1000, bavail: 250 }));
  assert.deepEqual(ok, { total: 4096 * 1000, free: 4096 * 250 });
  assert.equal(readDiskSpace('/x', () => { throw new Error('ENOENT'); }), null);
  assert.equal(readDiskSpace('/x', () => ({ bsize: 0, blocks: 0 })), null);
  assert.equal(readDiskSpace('/x', () => ({ bsize: 1, blocks: 100, bfree: 40 })).free, 40, '没有 bavail 时用 bfree');
});

test('evaluateDiskState：水位三档 + 快照两档，reason 写清楚', () => {
  const ok = evaluateDiskState({ freeBytes: 100 * GB, snapshotBytes: 1 * GB });
  assert.equal(ok.level, 'ok');
  assert.deepEqual(ok.reasons, []);

  const warnFree = evaluateDiskState({ freeBytes: 25 * GB, snapshotBytes: 0 });
  assert.equal(warnFree.level, 'warn');
  assert.ok(warnFree.reasons[0].includes('接近下限'));

  const critical = evaluateDiskState({ freeBytes: 5 * GB, snapshotBytes: 30 * GB });
  assert.equal(critical.level, 'critical');
  assert.equal(critical.reasons.length, 2);

  const warnSnap = evaluateDiskState({ freeBytes: 100 * GB, snapshotBytes: 15 * GB });
  assert.equal(warnSnap.level, 'warn');
  assert.ok(warnSnap.reasons[0].includes('TEMP 快照'));

  const snapCritical = evaluateDiskState({ freeBytes: 100 * GB, snapshotBytes: 25 * GB });
  assert.equal(snapCritical.level, 'critical', '超过阈值 2 倍是 critical');
});

test('evaluateDiskState：读不到磁盘（freeBytes=null）不判成 critical', () => {
  const r = evaluateDiskState({ freeBytes: null, snapshotBytes: 0 });
  assert.equal(r.level, 'ok');
  assert.equal(r.freeGB, null);
  assert.equal(r.totalGB, null);
});

test('selectStaleDirs：按 mtime 挑超过 maxAge 的；非法 mtime 不算', () => {
  const stale = selectStaleDirs([
    { name: 'old', mtimeMs: NOW - 13 * 3600 * 1000 },
    { name: 'fresh', mtimeMs: NOW - 1000 },
    { name: 'bad' },
  ], { maxAgeMs: 12 * 3600 * 1000, now: NOW });
  assert.deepEqual(stale.map((d) => d.name), ['old']);
});

test('removeSnapshotDirs：只删前缀目录且必须在临时根下；双保险拦住越界路径', () => {
  const root = tmpRoot();
  const dir = path.join(root, `${DEFAULT_TEMP_PREFIX}1`);
  fs.mkdirSync(dir);
  const good = { name: `${DEFAULT_TEMP_PREFIX}1`, path: dir, bytes: 100 };
  const badName = { name: 'other-dir', path: path.join(root, 'other-dir'), bytes: 1 };
  const badPath = { name: `${DEFAULT_TEMP_PREFIX}2`, path: path.join(os.tmpdir(), `${DEFAULT_TEMP_PREFIX}2`), bytes: 1 };
  const r = removeSnapshotDirs([good, badName, badPath], { tempRoot: root });
  assert.deepEqual(r.removed.map((x) => x.name), [`${DEFAULT_TEMP_PREFIX}1`]);
  assert.equal(r.freedBytes, 100);
  assert.equal(r.failed.length, 2);
  assert.equal(fs.existsSync(dir), false);
});

test('createDiskGuard：关闭时不采样；开启时给出 level/快照数并记一行日志', () => {
  const root = tmpRoot();
  const logs = [];
  const off = createDiskGuard({ enabled: false, tempRoot: root, log: (m) => logs.push(m), statfs: () => ({ bsize: GB, blocks: 100, bavail: 50 }) });
  assert.equal(off.sample(), null);

  const guard = createDiskGuard({
    tempRoot: root, log: (m) => logs.push(m), now: () => NOW,
    statfs: () => ({ bsize: GB, blocks: 100, bavail: 50 }),
    list: () => [{ name: `${DEFAULT_TEMP_PREFIX}1`, bytes: 2 * GB, mtimeMs: NOW }],
  });
  const st = guard.sample();
  assert.equal(st.level, 'ok');
  assert.equal(st.snapshotCount, 1);
  assert.ok(st.snapshotGB >= 1.9);
  assert.ok(logs.some((l) => l.startsWith('[disk] C:')));
  assert.equal(guard.state(), st);
});

test('createDiskGuard：默认只观察——即使 cleanup=true，observeOnly 为真也不删', () => {
  let removed = 0;
  const guard = createDiskGuard({
    cleanup: true, observeOnly: true, tempRoot: '/tmp', now: () => NOW,
    statfs: () => ({ bsize: GB, blocks: 100, bavail: 1 }), // 5GB 可用 → critical
    list: () => [{ name: `${DEFAULT_TEMP_PREFIX}old`, path: `/tmp/${DEFAULT_TEMP_PREFIX}old`, bytes: 1, mtimeMs: NOW - 24 * 3600 * 1000 }],
    remove: () => { removed += 1; },
  });
  const st = guard.sample();
  assert.equal(st.level, 'critical');
  assert.equal(st.cleaned, null);
  assert.equal(removed, 0, '观察模式绝不动手');
});

test('createDiskGuard：显式开启 cleanup 且非观察模式，才清过期快照并记账', () => {
  const root = tmpRoot();
  const dir = path.join(root, `${DEFAULT_TEMP_PREFIX}old`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x'), '1234');
  const logs = [];
  const guard = createDiskGuard({
    cleanup: true, observeOnly: false, tempRoot: root, now: () => NOW, log: (m) => logs.push(m),
    statfs: () => ({ bsize: GB, blocks: 100, bavail: 1 }), // 5GB → critical
    list: () => listSnapshotDirs({ tempRoot: root }).map((d) => ({ ...d, mtimeMs: NOW - 24 * 3600 * 1000 })),
  });
  const st = guard.sample();
  assert.equal(st.level, 'critical');
  assert.equal(st.cleaned.count, 1);
  assert.equal(st.cleaned.freedBytes, 4);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(logs.some((l) => l.includes('清理过期快照 1 个')));
});

test('createDiskGuard：日志节流（同级别不重复刷，超过 1 小时心跳一次）', () => {
  const logs = [];
  let t = NOW;
  const guard = createDiskGuard({
    tempRoot: '/tmp', log: (m) => logs.push(m), now: () => t,
    statfs: () => ({ bsize: GB, blocks: 100, bavail: 50 }), list: () => [],
  });
  guard.sample();
  assert.equal(logs.length, 1, '首次一定记');
  t += 60_000;
  guard.sample();
  assert.equal(logs.length, 1, '同级且未到心跳不重复');
  t += 60 * 60 * 1000;
  guard.sample();
  assert.equal(logs.length, 1, 'ok 级别不心跳');
});

test('createDiskGuard：start 首次采样延后 10 秒、stop 清定时器', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const logs = [];
  let samples = 0;
  const guard = createDiskGuard({
    tempRoot: '/tmp', log: (m) => logs.push(m), sampleMs: 60000,
    statfs: () => ({ bsize: GB, blocks: 100, bavail: 50 }), list: () => [],
    now: () => NOW,
  });
  const origSample = guard.sample;
  guard.start();
  assert.equal(samples, 0);
  t.mock.timers.tick(10_000);
  assert.ok(guard.state(), '10 秒后完成首次采样');
  guard.stop();
  const before = guard.state();
  t.mock.timers.tick(120_000);
  assert.equal(guard.state(), before, 'stop 之后不再采样');
  assert.ok(origSample);
});

test('DEFAULT_THRESHOLDS：20GB 可用 / 12GB 快照 / 12 小时', () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { minFreeGB: 20, maxSnapshotGB: 12, maxAgeHours: 12 });
});
