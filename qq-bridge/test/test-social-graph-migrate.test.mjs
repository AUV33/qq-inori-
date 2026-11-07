// test-social-graph-migrate.test.mjs · S6b：旧昵称键社交图迁到 personId，歧义不猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { personIdFor } from '../src/domain/social/identity-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/social-graph-migrate.mjs');
const T = 1793248443424;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-migrate-'));
  const state = path.join(root, 'data', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'people.json'), JSON.stringify({
    '10001': { aliases: { g: '小明' } },
    '10002': { aliases: { g: '小红' } },
    '10003': { aliases: { g: '同名' } },
    '10004': { aliases: { g: '同名' } },
  }), 'utf8');
  fs.writeFileSync(path.join(state, 'social-graph.json'), JSON.stringify({
    groups: {
      'group:1': {
        updatedAt: T,
        pairs: {
          '小明|小红': { a: '小明', b: '小红', ab: 2, ba: 1, reply: 2, adjacent: 1, mention: 0, pos: 1, neg: 0, lastAt: T },
          '同名|小明': { a: '同名', b: '小明', ab: 1, ba: 0, reply: 1, adjacent: 0, mention: 0, pos: 0, neg: 0, lastAt: T },
        },
      },
    },
  }), 'utf8');
  return { root, state };
}
function run(root, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_INORI_ROOT: root },
  });
}

test('dry-run 不改文件；apply 迁移可解析的行、歧义/未解析保留', () => {
  const { root, state } = setup();
  const before = fs.readFileSync(path.join(state, 'social-graph.json'), 'utf8');

  const dry = run(root);
  assert.equal(dry.status, 0, dry.stderr);
  const dryBody = JSON.parse(dry.stdout);
  assert.equal(dryBody.migrated, 1);
  assert.equal(dryBody.skipped, 1);
  assert.equal(fs.readFileSync(path.join(state, 'social-graph.json'), 'utf8'), before, 'dry-run 不得改文件');

  const applied = run(root, ['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  const body = JSON.parse(applied.stdout);
  assert.equal(body.migrated, 1);
  assert.ok(body.changed);

  const graph = JSON.parse(fs.readFileSync(path.join(state, 'social-graph.json'), 'utf8'));
  const pairs = graph.groups['group:1'].pairs;
  const pidA = personIdFor('qq', '10001');
  const pidB = personIdFor('qq', '10002');
  const key = pidA <= pidB ? `${pidA}|${pidB}` : `${pidB}|${pidA}`;
  assert.ok(pairs[key], '应生成 personId 键');
  assert.equal(pairs[key].a, pidA <= pidB ? pidA : pidB);
  assert.equal(pairs[key].ab + pairs[key].ba, 3, '计数不能在换序时丢');
  const aIsMing = pairs[key].a === pidA;
  assert.equal(pairs[key].aName, aIsMing ? '小明' : '小红');
  assert.equal(pairs[key].bName, aIsMing ? '小红' : '小明');
  assert.ok(pairs['同名|小明'], '歧义昵称必须原样保留');

  const backup = fs.readdirSync(state).find((f) => f.startsWith('social-graph.json.bak-socialid-'));
  assert.ok(backup, '写回前必须备份');
});

test('幂等：第二次 apply 不再迁移；已 canonical 的行保留', () => {
  const { root, state } = setup();
  run(root, ['--apply']);
  const second = run(root, ['--apply']);
  assert.equal(second.status, 0, second.stderr);
  const body = JSON.parse(second.stdout);
  assert.equal(body.migrated, 0);
  assert.equal(body.merged, 0);
  const graph = JSON.parse(fs.readFileSync(path.join(state, 'social-graph.json'), 'utf8'));
  assert.ok(graph.groups['group:1'].pairs['同名|小明']);
});
