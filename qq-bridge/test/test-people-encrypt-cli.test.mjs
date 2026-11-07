// test-people-encrypt-cli.test.mjs · S6b-5d：加密迁移/轮换工具（dry-run 默认、写后校验、备份）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/people-encrypt.mjs');
const KEY1 = Buffer.alloc(32, 3).toString('hex');
const KEY2 = Buffer.alloc(32, 4).toString('hex');
const T = 1793840000000;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'people-encrypt-cli-'));
  const state = path.join(root, 'data', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'people.json'), JSON.stringify({ '10001': { id: '10001', aliases: { g: '小明' } } }), 'utf8');
  return { root, file: path.join(state, 'people.json') };
}
function run(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_INORI_ROOT: root, QQ_INORI_PEOPLE_KEY: KEY1, ...extraEnv },
  });
}

test('status/apply：默认 dry-run；--apply 写密文并备份+校验；已加密拒绝再 apply', () => {
  const { root, file } = setup();
  const before = fs.readFileSync(file, 'utf8');
  let out = run(root, ['status']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).encrypted, false);

  out = run(root, ['apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry-run 不改文件');

  out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.applied, true);
  assert.ok(body.backup);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('10001'), false);
  assert.ok(fs.existsSync(body.backup));

  out = run(root, ['verify']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).ok, true);

  out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 1, '已加密不得重复 apply');
});

test('apply dry-run：不生成密钥文件、不改数据', () => {
  const { root, file } = setup();
  const before = fs.readFileSync(file, 'utf8');
  const env = { ...process.env, QQ_INORI_ROOT: root };
  delete env.QQ_INORI_PEOPLE_KEY;
  delete env.QQ_INORI_PEOPLE_KEY_FILE;
  const out = spawnSync(process.execPath, [SCRIPT, 'apply', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'data', 'state', 'secrets', 'people.key')), false, 'dry-run 不得生成密钥');
});

test('doctor：明文时失败；加密后报告 people/备份/env 警告', () => {
  const { root } = setup();
  let out = run(root, ['doctor']);
  assert.equal(out.status, 1, '明文应失败');
  assert.ok(JSON.parse(out.stdout).warnings.includes('plaintext'));

  out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  out = run(root, ['doctor']);
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.encrypted, true);
  assert.equal(body.people, 1);
  assert.equal(body.backups, 1);
  assert.ok(body.warnings.includes('plaintext-backup-exists'));
});

test('--key-file 优先于 env：显式文件不会被 env 旧钥盖过', () => {
  const { root } = setup();
  let out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  const keyFile = path.join(root, 'data', 'state', 'secrets', 'people.key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, KEY1 + '\n', { encoding: 'utf8', mode: 0o600 });

  const verify = (extraEnv) => spawnSync(process.execPath, [SCRIPT, 'verify', '--key-file=' + keyFile, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_INORI_ROOT: root, ...extraEnv },
  });
  out = verify({ QQ_INORI_PEOPLE_KEY: KEY2 });
  assert.equal(out.status, 0, '显式 key-file 应压过错误的 env 密钥');
  assert.equal(JSON.parse(out.stdout).people, 1);

  out = spawnSync(process.execPath, [SCRIPT, 'verify', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_INORI_ROOT: root, QQ_INORI_PEOPLE_KEY: KEY2 } });
  assert.equal(out.status, 1, '没有 --key-file 时 env 仍生效');
});

test('apply --key-file + env：标记 envKeySet，运行时用文件钥而不是 env 旧钥', () => {
  const { root } = setup();
  const keyFile = path.join(root, 'data', 'state', 'secrets', 'people.key');
  let out = run(root, ['apply', '--apply', '--key-file=' + keyFile]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).envKeySet, true);

  out = run(root, ['verify', '--key-file=' + keyFile]);
  assert.equal(out.status, 0, '文件钥应能解开');
  out = run(root, ['verify']);
  assert.equal(out.status, 1, 'env 旧钥解不开（提醒是必要的）');
});

test('rotate：env 仍优先时要在 JSON 标记 envKeySet，提醒运行时没换钥', () => {
  const { root } = setup();
  let out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  const keyFile = path.join(root, 'data', 'state', 'secrets', 'people.key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, KEY1 + '\n', 'utf8');
  out = run(root, ['rotate', '--new-key=' + KEY2, '--key-file=' + keyFile, '--apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).envKeySet, true);
});

test('rotate 密钥写回失败：people 回滚到旧钥版本，不留新数据+旧钥死局', () => {
  const { root, file } = setup();
  let out = run(root, ['apply', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  const encrypted = fs.readFileSync(file, 'utf8');

  const keyFile = path.join(root, 'data', 'state', 'secrets', 'people.key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, KEY1 + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(keyFile, 0o444);
  out = run(root, ['rotate', '--new-key=' + KEY2, '--key-file=' + keyFile, '--apply']);
  fs.chmodSync(keyFile, 0o600);
  assert.equal(out.status, 1, '密钥写回失败必须失败');
  assert.equal(JSON.parse(out.stdout).rolledBack, true);
  assert.equal(fs.readFileSync(file, 'utf8'), encrypted, '回滚后应恢复旧密文字节');

  out = run(root, ['verify']);
  assert.equal(out.status, 0, '旧钥仍能解开（已回滚）');
});

test('rotate --key-file：新钥写回密钥文件，旧钥文件有备份', () => {
  const { root, file } = setup();
  const keyFile = path.join(root, 'data', 'state', 'secrets', 'people.key');
  const env = { ...process.env, QQ_INORI_ROOT: root };
  delete env.QQ_INORI_PEOPLE_KEY;
  delete env.QQ_INORI_PEOPLE_KEY_FILE;
  const spawn = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env });

  let out = spawn('apply', '--apply', '--key-file=' + keyFile);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(keyFile));

  out = spawn('rotate', '--new-key=' + KEY2, '--key-file=' + keyFile, '--apply');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).keyPersisted, true);
  assert.equal(JSON.parse(out.stdout).envKeySet, false);
  assert.ok(fs.readdirSync(path.dirname(keyFile)).some((f) => f.includes('.bak-key-')), '旧钥要备份');

  out = spawn('verify', '--key-file=' + keyFile);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).people, 1);

  out = spawnSync(process.execPath, [SCRIPT, 'verify', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...env, QQ_INORI_PEOPLE_KEY: KEY1 } });
  assert.equal(out.status, 1, '旧钥不得再解开');
});

test('rotate：显式新钥才允许；轮换后旧钥解不开、新钥能解开', () => {
  const { root, file } = setup();
  run(root, ['apply', '--apply']);
  const before = fs.readFileSync(file, 'utf8');

  let out = run(root, ['rotate', '--apply']);
  assert.equal(out.status, 1, '不给新钥必须拒绝');
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  out = run(root, ['rotate', `--new-key=${KEY2}`, '--apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, true);

  const after = fs.readFileSync(file, 'utf8');
  assert.notEqual(after, before);
  // 旧钥 verify 失败、新钥 verify 成功
  out = run(root, ['verify']);
  assert.equal(out.status, 1, '旧钥应解不开新密文');
  out = run(root, ['verify'], { QQ_INORI_PEOPLE_KEY: KEY2 });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).people, 1);
});
