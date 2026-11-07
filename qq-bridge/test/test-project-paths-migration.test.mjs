import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(BRIDGE, 'src');

// 本批已迁移的模块：默认路径必须来自 project-paths，不能写死仓库位置。
const MIGRATED = [
  'inori-state.js',
  'inori-lessons.js',
  'inori-goals.js',
  'inori-thoughts.js',
  'inori-traces.js',
  'inori-skills.js',
  'inori-works.js',
  'inori-taskledger.js',
  'inori-rumination.js',
  'inori-lifestate.js',
  'inori-groupmembers.js',
  'inori-failures.js',
  'inori-browse.js',
  'inori-people.js',
  'inori-behavior-ledger.js',
  'inori-actionlog.js',
  'inori-prompts.js',
  'inori-focus.js',
  'inori-learning-loop.js',
  'inori-activity.js',
  'inori-workshop.js',
  'memory-retrieve.js',
];

test('project-paths：QQ_INORI_ROOT 覆盖后所有派生路径同步变化', () => {
  const root = path.join(os.tmpdir(), `qq-inori-root-${process.pid}-${Date.now()}`);
  const code = `
    import { PROJECT_ROOT, QQ_BRIDGE_DIR, DATA_DIR, STATE_DATA_DIR, MEMORY_DIR, bridgePath, stateDataPath } from './src/domain/shared/project-paths.js';
    console.log(JSON.stringify({ PROJECT_ROOT, QQ_BRIDGE_DIR, DATA_DIR, STATE_DATA_DIR, MEMORY_DIR, f: bridgePath('state','slang.json'), g: stateDataPath('goals.json') }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: BRIDGE,
    env: { ...process.env, QQ_INORI_ROOT: root },
    encoding: 'utf8',
  });
  const got = JSON.parse(out.trim());
  assert.equal(got.PROJECT_ROOT, root);
  assert.equal(got.QQ_BRIDGE_DIR, path.join(root, 'qq-bridge'));
  assert.equal(got.DATA_DIR, path.join(root, 'data'));
  assert.equal(got.STATE_DATA_DIR, path.join(root, 'data', 'state'));
  assert.equal(got.MEMORY_DIR, path.join(root, 'data', 'memory'));
  assert.equal(got.f, path.join(root, 'qq-bridge', 'state', 'slang.json'));
  assert.equal(got.g, path.join(root, 'data', 'state', 'goals.json'));
});

test('project-paths：默认根目录推导回当前仓库', () => {
  const code = `
    import { PROJECT_ROOT } from './src/domain/shared/project-paths.js';
    console.log(PROJECT_ROOT);
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: BRIDGE,
    env: { ...process.env, QQ_INORI_ROOT: '' },
    encoding: 'utf8',
  });
  assert.equal(out.trim(), path.resolve(BRIDGE, '..'));
});

for (const file of MIGRATED) {
  test(`路径迁移：src/${file} 不写死仓库位置`, () => {
    // 叶子/服务可能已迁到 src/domain/<族>/：按文件名递归找
    const findIn = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const hit = findIn(p); if (hit) return hit; }
        else if (e.name === file) return p;
      }
      return null;
    };
    const full = findIn(SRC);
    assert.ok(full, `${file} 不存在`);
    const text = fs.readFileSync(full, 'utf8');
    assert.equal(/D:[\\/]+qq-inori/i.test(text), false, `${file} 仍含 D:/qq-inori 字面量`);
    assert.match(text, /from '(?:\.\.?\/)+(?:shared\/)?project-paths\.js'/, `${file} 未从 project-paths 取路径`);
  });
}
