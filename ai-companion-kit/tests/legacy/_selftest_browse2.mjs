import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 随机源测试：连逛 3 次（不指定网址），看豆瓣/虎扑/小黑盒是否出内容
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';

const c = new Client({ name: 'browse2', version: '1.0.0' }, { capabilities: {} });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: path.join(os.tmpdir(), 'mem-b2-' + Date.now()) },
}));

for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  const r = await c.callTool({ name: 'browse_posts', arguments: {} });
  const body = (r.content ?? []).map((x) => x.text ?? '').join(' ');
  const head = body.split('\n').slice(0, 3).join(' | ');
  console.log(`[${i}] ${r.isError ? 'ERROR' : 'OK'} ${Date.now() - t0}ms ${body.length} 字`);
  console.log('    ' + head.slice(0, 150));
  if (i < 3) await new Promise((s) => setTimeout(s, 6000));
}
await c.close();
