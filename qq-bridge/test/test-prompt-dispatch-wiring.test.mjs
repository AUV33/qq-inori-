import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readBridgeSource } from '../scripts/lib/bridge-source.mjs';

// 桥接实现已迁到 app.mjs（2026-10-28 入口拆分），源码级断言统一读合集。
const bridge = readBridgeSource();
// 视觉的生命周期已抽到独立模块（[VISION-SERVICE]）：标签在那里声明，两边合起来校验。
const visionService = fs.readFileSync(fileURLToPath(new URL('../src/domain/send/vision-service.js', import.meta.url)), 'utf8');
const sources = `${bridge}\n${visionService}`;

test('所有 DSH prompt 都经过唯一生命周期包装器', () => {
  const rawCalls = bridge.match(/api\.sessions\.prompt\s*\(/g) || [];
  assert.equal(rawCalls.length, 1, '新增 prompt 调用必须接入 submitPromptWithTurnSlot');
  assert.ok(bridge.includes('async function submitPromptWithTurnSlot'));
  assert.ok(bridge.includes('return submitTurnPrompt({'), '桥接包装器必须委托给可单测的生命周期模块');
});

test('聊天、学习、视觉、群事实和任务都声明了调度类别', () => {
  for (const label of ['isolated:slang', 'isolated:vision', 'isolated:groupfact', 'task:']) {
    assert.ok(sources.includes(label), `缺少调度标签：${label}`);
  }
  assert.ok(bridge.includes("kind: 'chat'"), '聊天投递没有声明 chat 类别');
  assert.ok(sources.includes("kind: 'background'"), '后台投递没有声明 background 类别');
});
