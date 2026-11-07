// test-self-anchor.test.mjs · 身份锚点：只记事实、只接受 her 的定义、坏行不吞。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildAnchorFacts, buildSelfDefinition, foldSelfAnchor, renderSelfAnchorLine, roleCardHash,
} from '../src/domain/mind/self-anchor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/self-anchor.mjs');
const SELF = 'p_aaaaaaaaaaaa';
const OWNER = 'p_bbbbbbbbbbbb';

test('锚点事实：pID/角色卡 hash 必须合法；定义只接受 her', () => {
  const facts = buildAnchorFacts({ selfPersonId: SELF, ownerPersonId: OWNER, name: '测试角色', nameSource: 'roles/x.md', roleCardHash: roleCardHash('卡'), createdAt: 123 });
  assert.equal(facts.kind, 'anchor');
  assert.equal(facts.selfPersonId, SELF);
  assert.throws(() => buildAnchorFacts({ selfPersonId: '10001', name: 'x', roleCardHash: roleCardHash('x'), createdAt: 1 }), /selfPersonId/);
  assert.throws(() => buildSelfDefinition({ text: '我是我', writer: 'system' }), /her/);
  assert.equal(buildSelfDefinition({ text: '我是我', writer: 'her', at: 2 }).text, '我是我');
});

test('折叠：最新锚点生效；坏行/未知行进 anomalies；渲染只给事实+她的定义', () => {
  const folded = foldSelfAnchor([
    { kind: 'anchor', at: 1, selfPersonId: SELF, ownerPersonId: OWNER, name: '旧名', roleCardHash: roleCardHash('a') },
    { kind: 'anchor', at: 2, selfPersonId: SELF, ownerPersonId: OWNER, name: '新名', roleCardHash: roleCardHash('b') },
    { kind: 'definition', at: 3, writer: 'her', text: '我是我自己' },
    { kind: 'definition', at: 4, writer: 'system', text: '系统定义' },
    { kind: 'wat' },
    null,
  ]);
  assert.equal(folded.anchor.name, '新名');
  assert.equal(folded.definitions.length, 1);
  assert.ok(folded.anomalies.length >= 3);
  const line = renderSelfAnchorLine(folded);
  assert.match(line, /身份锚点/);
  assert.match(line, /新名/);
  assert.match(line, /我是我自己/);
  assert.equal(line.includes('系统定义'), false);
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-anchor-'));
  fs.mkdirSync(path.join(root, 'qq-bridge', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qq-bridge', 'config.json'), JSON.stringify({ ownerQQ: 10002, workspaceTitle: '测试角色' }), 'utf8');
  fs.writeFileSync(path.join(root, 'qq-bridge', 'roles', '测试角色.md'), '# 测试角色\n她是谁。', 'utf8');
  return root;
}
function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_INORI_ROOT: root },
  });
}

test('CLI：init dry-run/apply/show；已有相同锚点不重复写', () => {
  const root = setup();
  let out = run(root, ['init', '--self-qq=10001', '--name=测试角色']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).anchored, false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'state', 'mind', 'self-anchor.jsonl')), false);

  out = run(root, ['init', '--self-qq=10001', '--name=测试角色', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).anchored, true);
  const file = path.join(root, 'data', 'state', 'mind', 'self-anchor.jsonl');
  const before = fs.readFileSync(file, 'utf8');

  out = run(root, ['init', '--self-qq=10001', '--name=测试角色', '--apply']);
  assert.equal(JSON.parse(out.stdout).anchored, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '相同锚点不重复追加');

  out = run(root, ['show']);
  const body = JSON.parse(out.stdout);
  assert.equal(body.anchor.name, '测试角色');
  assert.equal(body.anchor.selfPersonId.startsWith('p_'), true);
  assert.match(body.line, /身份锚点/);
});

test('CLI define：默认 operator 拒绝；显式 writer=her 才追加', () => {
  const root = setup();
  assert.equal(run(root, ['init', '--self-qq=10001', '--name=测试角色', '--apply']).status, 0);
  let out = run(root, ['define', '--text=我是我', '--apply']);
  assert.equal(out.status, 1);
  out = run(root, ['define', '--text=我是我', '--writer=her', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  out = run(root, ['show']);
  assert.equal(JSON.parse(out.stdout).definitions.length, 1);
});
