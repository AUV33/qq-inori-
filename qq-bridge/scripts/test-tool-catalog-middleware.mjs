// test-tool-catalog-middleware.mjs · 「核心常驻 + 分类目录」中间件的回归测试
//
// 两段：
//   A) 假 server：验证 middleware 的四条核心行为
//      （核心集注册 / 其余隐藏 / catalog 总览与分类 / 按名调用隐藏工具）
//   B) 真 stdio：拉起 phone / qzone / memory 三个 MCP 服务，确认工具面真的缩小、
//      目录工具出现、分类详情可读。不调用任何会碰手机/网络的业务工具。
//
// 跑法：node scripts/test-tool-catalog-middleware.mjs（或 npm run test:tool-catalog）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installToolCatalog } from '../../ai-companion-kit/packages/shared/mcp-tool-catalog.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.resolve(ROOT, '..', 'ai-companion-kit', 'packages');

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`✅ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`❌ ${label}\n   ${error?.message ?? error}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function contains(haystack, needle, label = needle) {
  assert(String(haystack).includes(needle), `期望包含「${label}」，实际：\n${String(haystack).slice(0, 800)}`);
}
function notContains(haystack, needle, label = needle) {
  assert(!String(haystack).includes(needle), `期望不包含「${label}」`);
}
function makeTextResult(text) {
  return { content: [{ type: 'text', text }] };
}

// ── A. 假 server ───────────────────────────────────────────────────────
function makeFakeServer() {
  const registered = new Map();
  const server = {
    tool(name, ...rest) {
      registered.set(name, { name, description: rest[0], params: rest[rest.length - 2], handler: rest[rest.length - 1] });
      return this;
    },
  };
  return { server, registered };
}

function setupFixture() {
  const { server, registered } = makeFakeServer();
  const calls = [];
  const catalog = installToolCatalog(server, {
    catalogName: 'demo_tools',
    coreTools: ['demo_core_a', 'demo_core_b'],
    groups: {
      第一组: ['demo_one', 'demo_two_hidden'],
      第二组: ['demo_three'],
      空组: ['demo_not_registered'],
    },
    describeDefault: (name) => `兜底说明(${name})`,
  });
  // 核心（注册）
  server.tool('demo_core_a', '核心 A 的描述', { x: {} }, async (args) => makeTextResult(`coreA:${args.x}`));
  server.tool('demo_core_b', '核心 B 的描述', {}, async () => makeTextResult('coreB'));
  // 隐藏（不注册）
  server.tool('demo_one', '第一个隐藏工具', { q: {} }, async (args) => { calls.push(args); return makeTextResult(`one:${args.q}`); });
  // 单参 handler：验证 (args) 与 (args, extra) 两种签名都能调
  server.tool('demo_two_hidden', '第二个隐藏工具（单参 handler）', {}, async (args) => makeTextResult(`two:${JSON.stringify(args)}`));
  server.tool('demo_three', '第三个隐藏工具', {}, async () => makeTextResult('three'));
  server.tool('demo_unlisted', '未分组的工具', {}, async () => makeTextResult('unlisted'));
  server.tool('demo_boom', '会抛错的工具', {}, async () => { throw new Error('炸了'); });
  return { server, registered, calls, catalog };
}

const { registered, calls, catalog } = setupFixture();
const catalogTool = registered.get('demo_tools');

function callCatalog(args) {
  return catalogTool.handler(args);
}

console.log('── A. 中间件行为（假 server）──');
await check('核心集被注册，其余工具不注册', () => {
  assert(registered.has('demo_core_a'), 'demo_core_a 应已注册');
  assert(registered.has('demo_core_b'), 'demo_core_b 应已注册');
  for (const n of ['demo_one', 'demo_two_hidden', 'demo_three', 'demo_unlisted', 'demo_boom']) {
    assert(!registered.has(n), `${n} 不应被注册（应隐藏）`);
  }
});
await check('隐藏集完整落表，未分组工具归入「其他」', () => {
  assert(catalog.hiddenTools.size === 5, `隐藏工具应为 5 个，实际 ${catalog.hiddenTools.size}`);
  const grouped = catalog.groupTools();
  assert(Array.isArray(grouped['第一组']) && grouped['第一组'].length === 2, '第一组应有 2 个工具');
  assert(grouped['第二组'].length === 1, '第二组应有 1 个工具');
  assert(grouped['其他'].includes('demo_unlisted'), '未分组工具应归入「其他」');
  assert(!('空组' in grouped), '空组（工具未注册）不应出现在目录里');
});
await check('category 不给 → 分类总览（分类名 + 数量 + 用法）', async () => {
  const r = await callCatalog({});
  contains(r.content[0].text, '第一组（2）');
  contains(r.content[0].text, '第二组（1）');
  contains(r.content[0].text, '其他（2）');
  contains(r.content[0].text, 'demo_tools(category="分类名")');
  contains(r.content[0].text, 'demo_tools(tool="工具名", arguments={...})');
  assert(!r.isError, '总览不应是错误');
});
await check('只传 category → 该分类的工具名 + 描述', async () => {
  const r = await callCatalog({ category: '第一组' });
  contains(r.content[0].text, 'demo_one：第一个隐藏工具');
  contains(r.content[0].text, 'demo_two_hidden：第二个隐藏工具（单参 handler）');
  assert(!r.content[0].text.includes('demo_three'), '不应串到别的分类');
});
await check('未知分类 → isError 并列出可用分类（不抛异常）', async () => {
  const r = await callCatalog({ category: '不存在的组' });
  assert(r.isError === true, '未知分类应返回 isError');
  contains(r.content[0].text, '可用分类');
  contains(r.content[0].text, '第一组');
});
await check('tool + arguments → 调用隐藏工具并透传参数', async () => {
  calls.length = 0;
  const r = await callCatalog({ tool: 'demo_one', arguments: { q: '你好' } });
  assert(!r.isError, '调用不应失败');
  assert(r.content[0].text === 'one:你好', `返回应为 one:你好，实际 ${r.content[0].text}`);
  assert(calls.length === 1 && calls[0].q === '你好', '参数应原样传给隐藏 handler');
});
await check('单参 handler 也能被调用（两种签名兼容）', async () => {
  const r = await callCatalog({ tool: 'demo_two_hidden', arguments: { a: 1 } });
  assert(!r.isError, '调用不应失败');
  contains(r.content[0].text, '"a":1');
});
await check('隐藏工具抛错 → isError，不冒泡', async () => {
  const r = await callCatalog({ tool: 'demo_boom' });
  assert(r.isError === true, '应返回 isError');
  contains(r.content[0].text, '炸了');
});
await check('未知工具名 → isError 并给出可用分类', async () => {
  const r = await callCatalog({ tool: 'no_such_tool' });
  assert(r.isError === true, '未知工具应返回 isError');
  contains(r.content[0].text, '没有可调用的工具');
  contains(r.content[0].text, '第一组（2）');
});

// ── B. 真 stdio：三个服务的工具面 ──────────────────────────────────────
const SERVERS = [
  {
    name: 'phone',
    cwd: path.join(KIT, 'phone-mcp'),
    script: path.join(KIT, 'phone-mcp', 'src', 'phone-mcp.js'),
    catalogName: 'phone_tools',
    // [SKETCH] phone_sketch 已进核心（画画是一笔一调用的连招，藏进目录会卡手），期望随之 +1
    core: ['phone_look', 'phone_dump', 'phone_tap', 'phone_text', 'phone_open_app', 'phone_status', 'phone_info', 'phone_macro', 'phone_tap_desc', 'phone_sketch'],
    hiddenCount: 32,
    hiddenSample: ['phone_ocr', 'ncm_play', 'qzone_post', 'phone_tap_text'],
    category: { name: '网易云音乐', expect: 'ncm_play' },
  },
  {
    name: 'qzone',
    cwd: path.join(KIT, 'qzone-mcp'),
    script: path.join(KIT, 'qzone-mcp', 'src', 'qzone-mcp.js'),
    catalogName: 'qzone_tools',
    core: ['qzone_feeds', 'qzone_post', 'qzone_my_posts', 'qzone_images'],
    hiddenCount: 8,
    hiddenSample: ['qzone_delete', 'qzone_comment', 'qzone_pic_save'],
    category: { name: '互动', expect: 'qzone_like' },
  },
  {
    name: 'memory',
    cwd: path.join(KIT, 'memory-mcp'),
    script: path.join(KIT, 'memory-mcp', 'src', 'memory-mcp.js'),
    catalogName: 'memory_tools',
    core: ['memory_save', 'memory_recall', 'lesson_write', 'lesson_list', 'goal_list', 'goal_add', 'cognition_save',
      'goal_progress', 'goal_done', 'learning_item', 'practice_start', 'practice_note', 'practice_result', 'practice_list', 'skill_draft'],
    hiddenCount: 9,
    hiddenSample: ['skill_save', 'trace_log', 'browse_posts', 'lesson_drop'],
    category: { name: '技能库', expect: 'skill_verify' },
  },
];

async function checkServer(s) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [s.script], cwd: s.cwd, stderr: 'pipe' });
  const client = new Client({ name: 'tool-catalog-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert(names.length === s.core.length + 1, `${s.name} 注册工具数应为 ${s.core.length + 1}（核心 ${s.core.length} + 目录 1），实际 ${names.length}：${names.join(', ')}`);
    for (const n of s.core) assert(names.includes(n), `${s.name} 缺少核心工具 ${n}`);
    assert(names.includes(s.catalogName), `${s.name} 缺少目录工具 ${s.catalogName}`);
    for (const n of s.hiddenSample) assert(!names.includes(n), `${s.name} 的 ${n} 应被隐藏，不该出现在工具清单里`);

    // 目录总览 + 分类详情（只读文本，不触发业务工具）
    const overview = await client.callTool({ name: s.catalogName, arguments: {} });
    contains(overview.content[0].text, s.category.name, `${s.name} 目录总览应含分类「${s.category.name}」`);
    const detail = await client.callTool({ name: s.catalogName, arguments: { category: s.category.name } });
    contains(detail.content[0].text, s.category.expect, `${s.name} 分类详情应列出 ${s.category.expect}`);

    console.log(`✅ ${s.name}: 常驻 ${s.core.length} + 目录 1，隐藏 ${s.hiddenCount}，分类「${s.category.name}」可展开`);
  } finally {
    try { await client.close(); } catch {}
  }
}

console.log('\n── B. 真 stdio：三个服务的工具面 ──');
for (const s of SERVERS) {
  try {
    await checkServer(s);
  } catch (error) {
    failures += 1;
    console.log(`❌ ${s.name}: ${error?.message ?? error}`);
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
