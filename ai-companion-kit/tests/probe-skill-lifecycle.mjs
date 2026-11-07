import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-skill-lifecycle.mjs · 技能清理/版本工具真机跑一遍（不改数据：只 list + 不存在的 id）
// 学习工具在 memory_tools 目录里，不在顶层直接注册；这是 tool-catalog 的预期行为。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'skill-lifecycle-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const catalog = async (args) => txt(await client.callTool({ name: 'memory_tools', arguments: args }));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log('catalog:', tools.includes('memory_tools'));
console.log('skill group:', (await catalog({ category: '技能库' })).slice(0, 500));
const listText = await catalog({ tool: 'skill_list', arguments: { status: 'all' } });
console.log('LIST →', listText.slice(0, 700));
const firstId = listText.match(/\[(s[0-9a-f]+)\]/)?.[1];
if (firstId) console.log('HISTORY →', (await catalog({ tool: 'skill_history', arguments: { id: firstId } })).slice(0, 700));
console.log('HISTORY(nonexistent) →', (await catalog({ tool: 'skill_history', arguments: { id: 'nope-not-exist' } })).slice(0, 200));
await client.close();
