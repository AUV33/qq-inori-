// test-mcp-reserved2-tools.test.mjs · mcp-reserved2-tools.js 的注册冒烟测试（满足模块闭环矩阵的「测到」信号）。
// 通过 stub server 跑一遍 registerReserved2Tools，确认：1) 导入链路无缺失符号；2) 工具组按预期注册出来。
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerReserved2Tools } from '../src/mcp-reserved2-tools.js';

test('registerReserved2Tools 在 stub server 上注册出 reserved2 工具组且不抛错', () => {
  const registered = [];
  const server = { tool: (name) => { registered.push(name); } };
  // 空 cfg 时，所有 `if (cfg.socialV2?.tools?.x !== false)` 守卫求值为 true（undefined !== false），全部注册。
  assert.doesNotThrow(() => registerReserved2Tools(server, {}));
  assert.ok(registered.length >= 20, `reserved2 工具组应注册 ≥20 个，实际 ${registered.length}`);
  assert.ok(registered.includes('qq_get_prompt'), `应含 qq_get_prompt，实际：${registered.join(',')}`);
});
