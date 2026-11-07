import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-browse-comments-live.mjs · 真机走一遍：浏览豆瓣话题页，看评论有没有一起读出来
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'browse-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const r = await client.callTool({ name: 'browse_posts', arguments: { url: 'https://www.douban.com/group/topic/503077552/' } });
const out = txt(r);
console.log('result len', out.length);
console.log('has 评论区:', out.includes('评论区'));
const i = out.indexOf('评论区');
console.log(out.slice(Math.max(0, i - 120), i + 500));
await client.close();
