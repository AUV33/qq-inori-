import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 验证记忆互通：群里能不能翻到私聊的记忆（两边都测）
import fs from 'node:fs';
import os from 'node:os';

const dir = path.join(os.tmpdir(), 'mem-share-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

const priv = [
  { day: '2026-10-20', time: '2026-10-20 10:00', text: '他说自己下周一生日（10月26日）。' },
  { day: '2026-10-21', time: '2026-10-21 09:00', text: '他最近在折腾一个 QQ 机器人的项目。' },
];
const grp = [
  { day: '2026-10-22', time: '2026-10-22 20:00', text: '群里的阿澈喜欢发游戏截图。' },
];
fs.writeFileSync(path.join(dir, 'memory.jsonl'), priv.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(dir, 'memory-group_123456789.jsonl'), grp.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

// ── A) 桥接侧：memory-retrieve.recall
const mr = await import('pathToFileURL(path.join(REPO_ROOT, "/qq-bridge/src/memory-retrieve.js")).href');
const g = await mr.recall('生日', { dir, scope: 'group:123456789', limit: 5 });
console.log('[A] 桥接侧 群 scope 检索「生日」: mode=' + g.mode + ' 命中 ' + g.entries.length + ' 条');
for (const e of g.entries) console.log('    [' + (e._scope || '?') + '] ' + e.text);

const p = await mr.recall('生日', { dir, scope: 'private', limit: 5 });
console.log('[A] 桥接侧 私聊 scope 检索「生日」: 命中 ' + p.entries.length + ' 条（不应看到群里的）');

const gAll = await mr.recall('', { dir, scope: 'group:123456789', limit: 10 });
console.log('[A] 桥接侧 群 scope 不带 query: ' + gAll.entries.length + ' 条，里面有私聊的？' +
  gAll.entries.some((e) => String(e.text).includes('生日')));

// ── B) MCP 侧：memory_recall
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const c = new Client({ name: 'share-test', version: '1.0.0' }, { capabilities: {} });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: dir },
}));
const r1 = await c.callTool({ name: 'memory_recall', arguments: { query: '生日', scope: 'group:123456789' } });
console.log('[B] MCP 群 scope 检索「生日」:');
console.log('    ' + (r1.content ?? []).map((x) => x.text).join(' ').split('\n').slice(0, 5).join('\n    '));
const r2 = await c.callTool({ name: 'memory_recall', arguments: { query: '生日' } });
console.log('[B] MCP 私聊 scope 检索「生日」:');
console.log('    ' + (r2.content ?? []).map((x) => x.text).join(' ').split('\n').slice(0, 3).join('\n    '));
await c.close();
fs.rmSync(dir, { recursive: true, force: true });
