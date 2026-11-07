import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 确认 memory-mcp 实际暴露的工具（含 goal/lesson）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'mem-tools-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const client = new Client({ name: 'tools-check', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: TMP, GOALS_FILE: path.join(TMP, 'goals.json') },
}));
const { tools } = await client.listTools();
console.log('工具数 =', tools.length);
for (const t of tools) console.log('  ·', t.name, '—', String(t.description ?? '').slice(0, 40));

// 目标工具端到端
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a ?? {} });
  return (r.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 160);
};
console.log('\n[goal_add] ', await call('goal_add', { text: '想把明日方舟装上' }));
console.log('[goal_list]', await call('goal_list', {}));
console.log('[goal_progress]', await call('goal_progress', { note: '在小米商店看了，只有预约' }));
console.log('[lesson_write]', await call('lesson_write', { text: '小米商店的预约不等于能装' }));
console.log('[lesson_list]', await call('lesson_list', {}));

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
