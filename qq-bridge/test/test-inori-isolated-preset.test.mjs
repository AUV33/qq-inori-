// inori-isolated-preset 金标：隔离会话的 preset 分派（她自己的时间给全权限，群相关只给只读）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedPresetFor } from '../src/domain/leaves/inori-isolated-preset.js';

test('gate 固定 qq-gate（判定会话工具极少）', () => {
  assert.equal(isolatedPresetFor('gate', {}), 'qq-gate');
  assert.equal(isolatedPresetFor('gate', { socialV2: { taskPool: { preset: 'x' } } }), 'qq-gate');
});

test('她自己的时间（ownlife / diary / reflect）用任务级 preset', () => {
  for (const kind of ['ownlife', 'diary', 'reflect']) {
    assert.equal(isolatedPresetFor(kind, {}), 'qq-chat-admin', kind);
  }
});

test('taskPool.preset 可覆盖 admin preset', () => {
  const cfg = { socialV2: { taskPool: { preset: 'my-admin' } } };
  assert.equal(isolatedPresetFor('ownlife', cfg), 'my-admin');
  assert.equal(isolatedPresetFor('gate', cfg), 'qq-gate', 'gate 不受覆盖影响');
});

test('其余（intake / vision / slang ...）只给 qq-chat', () => {
  for (const kind of ['intake', 'vision', 'slang', 'groupfact', 'task', 'unknown']) {
    assert.equal(isolatedPresetFor(kind, {}), 'qq-chat', kind);
  }
});
