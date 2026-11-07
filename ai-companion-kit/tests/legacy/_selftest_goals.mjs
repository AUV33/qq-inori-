import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 验证 memory-mcp 新增的 goal_* 工具（写入临时 GOALS_FILE，不污染真实目标）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'goals-mcp-' + Date.now() + '.json');
const client = new Client({ name: 'goal-test', version: '1.2.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, GOALS_FILE: TMP, MEMORY_DIR: path.join(os.tmpdir(), 'mem-noop-' + Date.now()) },
}));

const txt = (r) => (r.content ?? []).map((c) => c.text ?? '').join(' ');
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const body = txt(r);
  console.log(`  ${r.isError ? 'ERR ' : '    '}${name} -> ${body.slice(0, 160).replace(/\n/g, ' / ')}`);
  return body;
};

console.log('[1] 工具清单：');
const tools = await client.listTools();
console.log('  ' + tools.tools.map((t) => t.name).join(', '));

console.log('\n[2] 新增一件事');
await call('goal_add', { text: '把这周的歌唱练完' });

console.log('\n[3] 重复添加应被拒');
await call('goal_add', { text: '把这周的歌唱练完' });

console.log('\n[4] 列表');
const list = await call('goal_list');
const id = /\[(g[0-9a-f]+)\]/.exec(list)?.[1];
console.log('  解析到 id =', id);

console.log('\n[5] 记进度');
await call('goal_progress', { id, note: '练了副歌' });

console.log('\n[6] 标记完成');
await call('goal_done', { id });

console.log('\n[7] 完成后列表应为空');
await call('goal_list');

console.log('\n[8] 落盘检查');
const raw = fs.readFileSync(TMP, 'utf8');
const j = JSON.parse(raw);
console.log('  goals 条数 =', j.goals.length, '| 状态 =', j.goals[0].status, '| 进度条数 =', j.goals[0].progress.length);

await client.close();
fs.rmSync(TMP, { force: true });
console.log('\n[9] 临时文件已清理');
