import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 实测 browse_posts：普通页 / SPA 渲染 / 节流
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';

const client = new Client({ name: 'browse-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: path.join(os.tmpdir(), 'mem-browse-' + Date.now()) },
}));

const txt = (r) => (r.content ?? []).map((c) => c.text ?? '').join(' ');
const call = async (label, args, maxShow = 220) => {
  const t0 = Date.now();
  const r = await client.callTool({ name: 'browse_posts', arguments: args });
  const body = txt(r);
  console.log(`\n[${label}] ${Date.now() - t0}ms  ${r.isError ? 'ERROR' : 'OK'}`);
  console.log('  ' + body.slice(0, maxShow).replace(/\n/g, '\n  '));
  return { err: !!r.isError, body };
};

const tools = await client.listTools();
console.log('工具清单含 browse_posts =', tools.tools.some((t) => t.name === 'browse_posts'));

await call('贴吧（普通页）', { url: 'https://tieba.baidu.com/f?kw=%E5%A3%B0%E4%BC%98' });
await new Promise((r) => setTimeout(r, 6000));
await call('小黑盒（SPA）', { url: 'https://www.xiaoheihe.cn/app/bbs/link/51c6729d32e0' }, 300);
await call('立刻再点（应被节流）', { url: 'https://tieba.baidu.com/' });
await call('非法网址（应报错）', { url: 'not-a-url' });

await client.close();
