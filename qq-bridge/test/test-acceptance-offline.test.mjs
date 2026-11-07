// test-acceptance-offline.test.mjs · S11y：离线验收聚合脚本可重复跑，关键项失败才 exit 1。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/acceptance-offline.mjs');
const T = Date.now();

test('验收聚合：有数据时关键项通过、返回 JSON 结构', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-offline-'));
  const state = path.join(root, 'data', 'state');
  const mem = path.join(root, 'data', 'memory');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(state, 'self-state.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(state, 'people.json'), JSON.stringify({ '10001': { id: '10001', aliases: { g: '小明' } } }), 'utf8');
  fs.writeFileSync(path.join(state, 'social-graph.json'), JSON.stringify({ groups: {} }), 'utf8');
  const rows = Array.from({ length: 12 }, (_, i) => ({ kind: 'utterance', text: '今天第 ' + i + ' 条，挺好', time: T - i * 1000 }));
  fs.writeFileSync(path.join(mem, 'memory.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const out = spawnSync(process.execPath, [SCRIPT, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QQ_INORI_ROOT: root },
  });
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.ok, true);
  assert.ok(body.checks.some((c) => c.name === 'living-eval' && c.ok === true));
  assert.ok(body.checks.some((c) => c.name === 'snapshot' && c.ok === true));
  assert.ok(body.checks.some((c) => c.name === 'runtime-pii'));
});

test('缺数据时：关键项 snapshot 仍可通过（空快照），非关键项给 warning 不失败', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-empty-'));
  const out = spawnSync(process.execPath, [SCRIPT, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QQ_INORI_ROOT: root },
  });
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.ok, true);
  const snap = body.checks.find((c) => c.name === 'snapshot');
  assert.equal(snap.ok, true, '没有关键文件也可以生成空清单并 verify');
  assert.ok(body.warnings >= 1, '没有基线/people 等应为 warning');

  // --strict：警告也当失败，用于发布前验收
  const strict = spawnSync(process.execPath, [SCRIPT, '--json', '--strict'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QQ_INORI_ROOT: root },
  });
  assert.equal(strict.status, 1, 'strict 模式警告应失败');
});
