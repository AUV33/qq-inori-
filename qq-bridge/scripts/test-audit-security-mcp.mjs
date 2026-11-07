// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import { TOOL_CONFIG_FLAGS as REAL_TOOL_CONFIG_FLAGS } from '../src/domain/shared/tool-flags.js';

function loadWebTools(safeFetch) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, { safeFetch, McpServer, StdioServerTransport: class {}, z, URL });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search uses bounded shared safeFetch after query sanitization', async () => {
  const calls = [];
  const callTool = loadWebTools(async (url, maxChars) => {
    calls.push({ url, maxChars });
    return { statusCode: 200, body: '<li class="b_algo"><h2><a href="https://example.com/">Fixture title</a></h2><p>Fixture summary</p></li>' };
  });
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.query, 'fixture phrase');
  assert.equal(parsed.results[0].title, 'Fixture title');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'fixture phrase');
  assert.equal(calls[0].maxChars, 512000);
});

test('MCP fetch uses shared transport and exposes rejection as a tool error', async () => {
  const callTool = loadWebTools(async () => { throw new Error('fixture: internal redirect rejected'); });
  for (const [name, args] of [['web_fetch', { url: 'http://example.com' }], ['web_search', { query: 'fixture' }]]) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /internal redirect rejected/);
  }
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools(async () => { assert.fail('Unexpected transport call'); });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
});

/**
 * 用假 transport 加载 mcp-snowluma-safe.js，拿到它的工具回调。
 * 只需要把 fetch（桥接 API / OneBot HTTP）、McpServer、zod、两个本地纯模块塞进上下文。
 */
function loadSnowlumaTools(fetchImpl, fixtureConfig = null) {
  const tools = new Map();
  // vm 里没有 ESM 的 import.meta，把模块顶部的 __dirname 推导整段替换成固定值。
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  const fixtureFs = fixtureConfig === null ? fs : {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'config.json' && String(file).includes('fixture')) {
        return JSON.stringify(fixtureConfig);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs: fixtureFs,
    SENSITIVE_RE: { test: () => false },
    TOOL_CONFIG_FLAGS: REAL_TOOL_CONFIG_FLAGS,
    serializeModelData: (value) => JSON.stringify(value),
  });
  return async (name, arguments_ = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} should be registered`);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

// 回归：桥接用 200 + {ok:false} 表达业务失败（例如发送被安全审计拦截）。
// agentApi 若不检查 body.ok，就会把「被拦截」当成「发送成功」报给模型 ——
// 模型据此认为消息已发出，既不再重试也不告诉用户，是典型的静默错误。
test('a bridge 200 with ok:false is reported to the model as a failure', async () => {
  const callTool = loadSnowlumaTools(async () => Response.json(
    { ok: false, error: '消息含敏感信息，已阻止发送' },
    { status: 200 },
  ));
  const result = await callTool('qq_send_group_message', { groupId: '456', message: 'fixture' });
  assert.equal(result.isError, true, 'ok:false 必须作为工具错误返回');
  assert.match(result.content[0].text, /阻止发送/);
});

// 回归：旧只读工具没有会话令牌，只能用在封闭 agent（管理员私聊）里。
// 桥接的 /api/status 对「带 agent 令牌」的调用返回最小对象（不含 mode 字段），
// 于是「看到 reserved2 才拒绝」的黑名单写法会判定为假 ⇒ 在二代仿真模式下放行，
// 把白名单群名、群成员名单注入模型上下文。
// 2026-10-25 审计后重写：旧只读工具（qq_list_groups / qq_get_group_members /
// qq_get_group_history）已从 mcp-snowluma-safe.js **删除**（连同 legacyReadToolAllowed）。
// 原因：桥接把「x-agent-call 声明」硬化为无活令牌一律 403（confused-deputy 修复），
// 而无令牌的 /api/status 探测拿不到 mode 字段 → 三个工具在**任何**模式下都必然报错
// （白烧 token + 诱导模型误调一个永远失败的工具）。
// 新不变式：群读能力只由带会话令牌的 v2 工具提供；工具面上不再有永远失败的入口。
function loadSnowlumaRegistry(fetchImpl, fixtureConfig = null) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  // fixtureConfig 非空时，模块读的 config.json 必须换成夹具（与 loadSnowlumaTools 同一纪律）；
  // 旧的实现这个参数是摆设（直接传真实 fs），开关类测试会被真实配置污染。
  const fixtureFs = fixtureConfig === null ? fs : {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'config.json' && String(file).includes('fixture')) {
        return JSON.stringify(fixtureConfig);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  vm.runInNewContext(source, {
    McpServer, StdioServerTransport: class {}, z, URL, URLSearchParams, fetch: fetchImpl,
    AbortSignal, process, setTimeout, clearTimeout, console, Buffer, path, fs: fixtureFs,
    SENSITIVE_RE: { test: () => false }, TOOL_CONFIG_FLAGS: {},
    serializeModelData: (value) => JSON.stringify(value),
    renderCatalog: () => '（fixture 目录）', renderCategory: () => '（fixture 分类）',
  });
  return tools;
}

test('legacy read tools are removed from the tool surface (always-broken entries gone)', () => {
  const tools = loadSnowlumaRegistry(async () => Response.json({ status: 'ok', retcode: 0 }));
  for (const name of ['qq_list_groups', 'qq_get_group_members', 'qq_get_group_history']) {
    assert.equal(tools.has(name), false, `${name} 必须不再注册（永远 403 的入口已删除）`);
  }
  // v2 的读/发工具面不受影响（群读能力的正确入口仍在）
  assert.equal(tools.has('qq_get_prompt'), true, 'v2 读工具仍在');
  assert.equal(tools.has('qq_get_active_members'), true, '群成员（活跃）读工具仍在');
  assert.equal(tools.has('qq_send_group_message'), true, '发送工具仍在');
});

// 旧测试「denied legacy group reads never reveal the group allowlist」的安全性质
// 现在由删除结构性保证：工具面上没有 legacy 群读入口 ⇒ 没有任何路径能把 allow.groups
// 泄给模型。保留一个等价断言：v2 发送被桥接 200+{ok:false} 拒绝时，报错如实透出且
// 不泄露白名单内容（用夹具模拟桥接侧的白名单拒绝文案）。
test('v2 send rejection surfaces without revealing the allowlist', async () => {
  const callTool = loadSnowlumaTools(async () => Response.json(
    { ok: false, error: '群 999999 不在白名单内' },
    { status: 200 },
  ), { allow: { groups: ['111111', '222222'] } });
  const result = await callTool('qq_send_group_message', { groupId: '999999', message: 'fixture' });
  assert.equal(result.isError, true, '白名单拒绝必须作为工具错误透出');
  assert.match(result.content[0].text, /999999 不在白名单内/);
  assert.doesNotMatch(result.content[0].text, /111111|222222/, '拒绝报错不得泄露白名单内容');
});

// 回归：qq_slang_judge（她自己判定词库：confirm/reject/list）
// 判定权归她 —— 工具面必须在她手里，且开关要在「注册期」生效（三处对齐纪律）。
test('qq_slang_judge routes list/confirm to the judge endpoint with the session token', async () => {
  const calls = [];
  const callTool = loadSnowlumaTools(async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return Response.json({ ok: true, action: 'list', pending: [] }, { status: 200 });
  });
  const list = await callTool('qq_slang_judge', { key: 'group:456', token: 'fixture-token', action: 'list' });
  assert.equal(list.isError, undefined, 'list 成功');
  assert.match(calls[0].url, /\/api\/socialV2\/slang\/judge$/, '路由到 judge 端点');
  assert.equal(JSON.parse(calls[0].body).action, 'list');
  const confirm = await callTool('qq_slang_judge', { key: 'group:456', token: 'fixture-token', action: 'confirm', content: 'wc' });
  assert.equal(confirm.isError, undefined, 'confirm 成功');
  assert.equal(JSON.parse(calls[1].body).content, 'wc');
});

test('qq_slang_judge is filtered at registration when the slangJudge switch is off', () => {
  const tools = loadSnowlumaRegistry(async () => Response.json({ ok: true }), {
    socialV2: { tools: { slangJudge: false } },
  });
  assert.equal(tools.has('qq_slang_judge'), false, '开关关 ⇒ 注册期必须不注册（同 curiosity/workshop 的三处对齐纪律）');
  assert.equal(tools.has('qq_slang_query'), true, '相邻的黑话工具不受影响');
  assert.equal(tools.has('qq_slang_submit'), true, '相邻的黑话工具不受影响');
});

