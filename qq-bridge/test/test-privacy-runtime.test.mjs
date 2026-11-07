// test-privacy-runtime.test.mjs · 宪章 G12：运行时档案的明文 PII 只报告、不回显。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/privacy-scan.mjs');

function run(dir, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--runtime', `--runtime-dir=${dir}`, '--json', ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
}

test('运行时扫描：发现 QQ 键/手机号，只给计数不回显值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-runtime-'));
  fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({ '10001': { aliases: { g: '示例甲' } } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'contact.json'), JSON.stringify({ phone: '13800138000' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ note: 'no pii' }), 'utf8');

  const out = run(dir);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.includes('10001'), false, '不得回显 QQ 号');
  assert.equal(out.stdout.includes('13800138000'), false, '不得回显手机号');
  const body = JSON.parse(out.stdout);
  assert.equal(body.files, 3);
  assert.ok(body.findings.some((f) => f.rule === 'json-key-qq' && f.count >= 1));
  assert.ok(body.findings.some((f) => f.rule === 'phone-cn' && f.count >= 1));
  assert.ok(body.total >= 2);
});

test('干净目录：0 命中、exit 0；--fail-on-runtime 才用退出码做门禁', () => {
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-clean-'));
  fs.writeFileSync(path.join(clean, 'ok.json'), JSON.stringify({ note: 'nothing' }), 'utf8');
  let out = run(clean);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).findings.length, 0);

  const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-dirty-'));
  fs.writeFileSync(path.join(dirty, 'people.json'), JSON.stringify({ '10002': {} }), 'utf8');
  out = run(dirty, ['--fail-on-runtime']);
  assert.equal(out.status, 1, '显式门禁时才失败');
});
