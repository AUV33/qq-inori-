import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-skill-verify.mjs · 真机跑一次 skill_verify（机检技能判据）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'skill-verify-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js")],
  env: { ...process.env },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log('has skill_verify:', tools.includes('skill_verify'), '| skill_edit:', tools.includes('skill_edit'));
for (const id of ['s3be0a653', 's684077cc']) {
  const r = await client.callTool({ name: 'skill_verify', arguments: { id } });
  console.log(id, '→', txt(r).slice(0, 240));
}
await client.close();
