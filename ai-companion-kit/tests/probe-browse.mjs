import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-browse.mjs · 实测 browse_posts（MCP stdio 直连）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';

const client = new Client({ name: 'browse-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: path.join(os.tmpdir(), 'mem-browse-probe-' + Date.now()) },
}));
const txt = (r) => (r.content ?? []).map((c) => c.text ?? '').join(' ');
const call = async (label, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name: 'browse_posts', arguments: args });
  const body = txt(r);
  console.log(`[${label}] ${Date.now() - t0}ms ${r.isError ? 'ERROR' : 'OK'} → ${body.slice(0, 160).replace(/\n/g, ' ')}`);
  return body;
};
const tools = await client.listTools();
console.log('工具清单含 browse_posts =', tools.tools.some((t) => t.name === 'browse_posts'));
await call('豆瓣小组', { url: 'https://www.douban.com/group/explore' });
await new Promise((r) => setTimeout(r, 5500));
await call('虎扑', { url: 'https://www.hupu.com/' });
await call('立刻再点（节流）', { url: 'https://www.hupu.com/' });
await call('非法网址', { url: 'not-a-url' });
await client.close();
