import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 端到端验证 memory-mcp（放在 kit 目录内，才能解析到 sdk）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'memory-mcp-selftest-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const client = new Client({ name: 'selftest', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: TMP },
});
await client.connect(transport);

const tools = await client.listTools();
console.log('[1] 工具清单 =', tools.tools.map((t) => t.name).join(', '));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args ?? {} });
  const txt = r.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`[2] ${name} -> ${txt}`);
  return txt;
};

await call('memory_save', { text: '他说下周要出差，三天', kind: 'fact' });
await call('memory_save', { text: '他养了只猫叫豆豆', kind: 'fact' });
await call('memory_save', { text: '他养了只猫，叫豆豆', kind: 'fact' }); // 去重测试
await call('memory_save', { text: '他不太喜欢别人问他私事', kind: 'impression' });
await call('memory_recall', { query: '猫' });
await call('memory_recall', {});
await call('memory_stats', {});

await client.close();

const f = path.join(TMP, 'memory.jsonl');
const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
console.log('[3] 落盘行数 =', lines.length, '（去重生效应为 3）');
for (const l of lines) console.log('    ' + l);
fs.rmSync(TMP, { recursive: true, force: true });
console.log('[4] 已清理临时目录');
