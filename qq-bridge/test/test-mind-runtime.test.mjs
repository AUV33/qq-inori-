// mind-runtime：把 groundwork / state-hub / resource-governor 装配在一起。
// 用临时 QQ_INORI_ROOT，避免碰真实 data/state。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('createMindRuntime：返回 groundwork / stateHub / governor / boot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mind-rt-'));
  process.env.QQ_INORI_ROOT = root;
  try {
    const { createMindRuntime } = await import('../src/domain/mind/mind-runtime.mjs');
    const rt = await createMindRuntime({ log: () => {} });
    assert.ok(rt.groundwork && typeof rt.groundwork.store.writeJson === 'function');
    assert.ok(rt.stateHub && typeof rt.stateHub.apply === 'function');
    assert.ok(rt.stateHub && typeof rt.stateHub.selectIntention === 'function');
    assert.ok(rt.governor && typeof rt.governor.canRun === 'function');
    assert.ok(rt.boot && typeof rt.boot === 'object');
  } finally {
    delete process.env.QQ_INORI_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
