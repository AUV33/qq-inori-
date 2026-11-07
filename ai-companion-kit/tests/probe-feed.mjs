import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-feed.mjs · 实测 feed_posts（stdio 直连 memory-mcp）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';

const client = new Client({ name: 'feed-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: path.join(os.tmpdir(), 'mem-feed-probe-' + Date.now()) },
}));
const txt = (r) => (r.content ?? []).map((c) => c.text ?? '').join(' ');
const call = async (label, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name: 'feed_posts', arguments: args });
  const body = txt(r);
  console.log(`[${label}] ${Date.now() - t0}ms ${r.isError ? 'ERROR' : 'OK'} → ${body.slice(0, 200).replace(/\n/g, ' | ')}`);
  return body;
};
const tools = await client.listTools();
console.log('工具清单含 feed_posts =', tools.tools.some((t) => t.name === 'feed_posts'));
await call('虎扑步行街（路由）', { url: '/hupu/bbs', max: 5 });
await call('立刻再刷（节流）', { url: '/zhihu/daily' });
await call('非法输入', { url: 'not-a-url' });
await new Promise((r) => setTimeout(r, 3500));
await call('知乎日报（路由）', { url: '/zhihu/daily', max: 3 });
await client.close();
