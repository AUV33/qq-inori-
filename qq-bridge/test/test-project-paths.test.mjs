import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('默认路径从模块位置推导到当前仓库，不依赖启动 cwd', async () => {
  const paths = await import(`../src/domain/shared/project-paths.js?default=${Date.now()}`);
  const expectedRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  assert.equal(paths.PROJECT_ROOT, expectedRoot);
  assert.equal(paths.QQ_BRIDGE_DIR, path.join(paths.PROJECT_ROOT, 'qq-bridge'));
  assert.equal(paths.stateDataPath('cognition.jsonl'), path.join(paths.PROJECT_ROOT, 'data', 'state', 'cognition.jsonl'));
});

test('QQ_INORI_ROOT 覆盖后所有派生路径一起迁移', async () => {
  const previous = process.env.QQ_INORI_ROOT;
  const root = path.resolve('D:/tmp/qq-inori-fixture');
  process.env.QQ_INORI_ROOT = root;
  try {
    const paths = await import(`../src/domain/shared/project-paths.js?override=${Date.now()}`);
    assert.equal(paths.PROJECT_ROOT, root);
    assert.equal(paths.MEMORY_DIR, path.join(root, 'data', 'memory'));
    assert.equal(paths.bridgePath('scripts', 'worker.py'), path.join(root, 'qq-bridge', 'scripts', 'worker.py'));
  } finally {
    if (previous == null) delete process.env.QQ_INORI_ROOT;
    else process.env.QQ_INORI_ROOT = previous;
  }
});
