// test-state-snapshot.test.mjs · 宪章 G4：快照可验证、恢复可演练、路径不越界。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createSnapshot, verifySnapshot, restoreSnapshot,
} from '../src/domain/shared/state-snapshot.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const T = Date.UTC(2026, 10, 5, 12);

function makeState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
  fs.writeFileSync(path.join(root, 'self-state.json'), JSON.stringify({ energy: 0.7 }), 'utf8');
  fs.writeFileSync(path.join(root, 'bonds.jsonl'), '{"kind":"observe"}\n', 'utf8');
  fs.mkdirSync(path.join(root, 'mind'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mind', 'state-hub.json'), JSON.stringify({ at: T }), 'utf8');
  return root;
}

test('默认清单按真实布局（mind/ 前缀）能找到文件，而不是全部 missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-layout-'));
  fs.mkdirSync(path.join(root, 'mind'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mind', 'self-state.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'mind', 'identity-map.jsonl'), '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'people.json'), '{}', 'utf8');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-layout-dst-'));
  const manifest = createSnapshot({ root, dest, now: T });
  assert.ok(manifest.files.some((f) => f.path === 'mind/self-state.json'));
  assert.ok(manifest.files.some((f) => f.path === 'people.json'));
  assert.equal(verifySnapshot({ dir: dest }).ok, true);
});

test('take/verify：清单带 sha256；篡改或缺失会被指出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-src-'));
  fs.writeFileSync(path.join(root, 'a.json'), 'alpha', 'utf8');
  fs.writeFileSync(path.join(root, 'b.jsonl'), 'beta\n', 'utf8');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-dst-'));
  const manifest = createSnapshot({ root, dest, files: ['a.json', 'b.jsonl', 'missing.json'], now: T });
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest.missing, ['missing.json']);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(verifySnapshot({ dir: dest }).ok, true);

  fs.writeFileSync(path.join(dest, 'a.json'), 'tampered', 'utf8');
  const bad = verifySnapshot({ dir: dest });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatched, ['a.json']);
});

test('restore：dry-run 不动；apply 覆盖且留 .bak；校验失败拒绝恢复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-restore-'));
  fs.writeFileSync(path.join(root, 'a.json'), 'v1', 'utf8');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-dst2-'));
  createSnapshot({ root, dest, files: ['a.json'], now: T });
  fs.writeFileSync(path.join(root, 'a.json'), 'v2', 'utf8');

  const dry = restoreSnapshot({ dir: dest, root, dryRun: true, at: T });
  assert.equal(dry.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.json'), 'utf8'), 'v2');

  const applied = restoreSnapshot({ dir: dest, root, dryRun: false, at: T });
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.json'), 'utf8'), 'v1');
  assert.ok(fs.existsSync(path.join(root, `a.json.bak-${T}`)));

  fs.writeFileSync(path.join(dest, 'a.json'), 'tampered', 'utf8');
  const refused = restoreSnapshot({ dir: dest, root, dryRun: false, at: T });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.skipped, ['a.json']);
});

test('路径越界被拒绝；state-hub 能直接打快照并验证', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-safe-'));
  fs.writeFileSync(path.join(root, 'a.json'), 'x', 'utf8');
  assert.throws(() => createSnapshot({ root, dest: root, files: ['../evil.json'] }), /越界/);

  fs.writeFileSync(path.join(root, 'self-state.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'state-hub.json'), '{}', 'utf8');
  const hub = createStateHub({ root, now: () => T, log: () => {} });
  hub.load();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-hub-'));
  const manifest = hub.snapshotTo(dest);
  assert.ok(manifest.files.some((f) => f.path === 'self-state.json'));
  assert.equal(hub.verifySnapshotAt(dest).ok, true);
});

test('脚本：take → verify → restore dry-run 全链路', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cli-'));
  fs.writeFileSync(path.join(root, 'self-state.json'), '{"energy":0.5}', 'utf8');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cli-dst-'));
  const script = path.join(ROOT, 'scripts/state-snapshot.mjs');

  const take = spawnSync(process.execPath, [script, 'take', `--root=${root}`, `--out=${dest}`, '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(take.status, 0, take.stderr);
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));

  const verify = spawnSync(process.execPath, [script, 'verify', `--dir=${dest}`, '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);

  const restore = spawnSync(process.execPath, [script, 'restore', `--dir=${dest}`, `--root=${root}`, '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).dryRun, true);
});
