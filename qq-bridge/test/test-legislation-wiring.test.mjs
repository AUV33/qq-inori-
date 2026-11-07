// test-legislation-wiring.test.mjs · 立法层不是"有模块但没入口"：从账本到工具面到端点必须真的接上。
// 服务全停时用源码契约测试锁住接线；运行时由 npm test 的 audit:wiring 再兜一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSOLE_TOOL_FLAGS, SOCIAL_V2_TOOLS_DEFAULTS } from '../src/domain/shared/tool-flags.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('工具开关：三件立法工具共用 legislation 开关，默认开，控制台可保存', () => {
  const flags = read('src/domain/shared/tool-flags.js');
  assert.match(flags, /legislation: true/);
  for (const name of ['qq_promise', 'qq_decline', 'qq_self_assess']) {
    assert.match(flags, new RegExp(`${name}: 'legislation'`), `${name} 缺少开关映射`);
  }
  // [AUDIT-FIX] 改为断言真实导出值，而不是锁死源码里的字面量顺序：
  // CONSOLE_TOOL_FLAGS 现在由默认表派生，静态断言会误报。
  for (const flag of ['wish', 'legislation', 'selfWake']) {
    assert.ok(CONSOLE_TOOL_FLAGS.includes(flag), `${flag} 不在控制台可保存清单`);
  }
  assert.deepEqual(
    [...CONSOLE_TOOL_FLAGS].sort(),
    Object.keys(SOCIAL_V2_TOOLS_DEFAULTS).sort(),
    '控制台 flag 清单必须完整覆盖默认表（不能漏，也不能多）',
  );
});

test('端点：只认她的活令牌（只读群窗/owner 不能代写），并通过 writer=her 落账', () => {
  const consoleServer = read('src/adapters/console-server.mjs');
  assert.match(consoleServer, /\/api\/socialV2\/legislation/);
  assert.match(consoleServer, /isLiveAgentToken\(agentToken\)/);
  assert.equal(/isReadToken\(agentToken\)/.test(consoleServer), false, '只读群窗令牌不得写立法账（P1-4）');
  assert.match(consoleServer, /createLegislationStore/);
  assert.match(consoleServer, /writer: 'her'/);
  assert.match(consoleServer, /v2ToolEnabled\('legislation'\)/);
});

test('MCP：三件工具都注册、都在常驻集合里、都出现在工具目录', () => {
  // 立法工具已随二代仿真组拆到 mcp-reserved2-tools.js；源码契约需同时检索两个文件。
  const mcp = read('src/mcp-snowluma-safe.js') + '\n' + read('src/mcp-reserved2-tools.js');
  for (const name of ['qq_promise', 'qq_decline', 'qq_self_assess']) {
    assert.ok(mcp.split(/\r?\n/).some((line) => line.trim().startsWith(`'${name}'`)), `${name} 未注册`);
    assert.ok(mcp.includes(`'${name}'`), `${name} 未出现在常驻/目录`);
  }
  const catalog = read('src/domain/persona/tool-catalog.js');
  for (const name of ['qq_promise', 'qq_decline', 'qq_self_assess']) {
    assert.ok(catalog.includes(name), `${name} 未登记工具目录`);
  }
});

test('宪章 §5.7：planWarning 训诫已废除；无计划自改只记事实（不自动扣 selfTrust）', () => {
  const consoleServer = read('src/adapters/console-server.mjs');
  assert.equal(/planWarning/.test(consoleServer), false, 'planWarning 必须彻底移除');
  assert.match(consoleServer, /planned,/);
  assert.match(consoleServer, /planned \? '' : '；无计划'/);
});
