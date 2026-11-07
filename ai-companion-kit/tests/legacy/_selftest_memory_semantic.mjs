import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// memory-mcp v1.1 端到端：验证语义检索 + 语义去重 + 服务不可用时降级
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'memory-sem-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

async function makeClient(embedUrl) {
  const c = new Client({ name: 'selftest', version: '1.1.0' }, { capabilities: {} });
  const env = { ...process.env, MEMORY_DIR: TMP };
  if (embedUrl !== undefined) env.MEMORY_EMBED_URL = embedUrl;
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
    env,
  }));
  return c;
}
const txt = (r) => r.content?.[0]?.text ?? JSON.stringify(r);

const MEMS = [
  '他最近总是加班到很晚',
  '他养了只猫叫豆豆',
  '他下周三要去医院复查胃',
  '他说过不喜欢别人问他工资',
  '他妈妈身体不太好',
  '他最近在学吉他和弦',
  '他对咖啡因很敏感，下午喝就睡不着',
];

let client = await makeClient();
console.log('[1] 写入 7 条');
for (const m of MEMS) {
  const r = await client.callTool({ name: 'memory_save', arguments: { text: m } });
  console.log('   ', txt(r));
}

console.log('\n[2] 语义去重（意思相近但字面不同的新条目）');
const dup = await client.callTool({ name: 'memory_save', arguments: { text: '他最近总是加班，很晚才回家' } });
console.log('   ', txt(dup));

console.log('\n[3] 检索断言（期望目标是否出现在返回里）');
const CASES = [
  { q: '工作', must: '加班' },
  { q: '猫', must: '豆豆' },
  { q: '钱', must: '工资' },
  { q: '音乐', must: '吉他' },
  { q: '睡觉', must: '咖啡因' },
  { q: '身体', must: '妈妈' },
];
let pass = 0;
for (const { q, must } of CASES) {
  const r = await client.callTool({ name: 'memory_recall', arguments: { query: q, limit: 5 } });
  const body = txt(r);
  const hit = body.includes(must);
  if (hit) pass++;
  const mode = /语义检索/.test(body) ? '语义' : '字面';
  console.log(`    「${q}」→ 要找「${must}」 ${hit ? '✓' : '✗'}  [${mode}]`);
}
console.log(`    结果 ${pass}/${CASES.length}`);

const stats = await client.callTool({ name: 'memory_stats', arguments: {} });
console.log('\n[4] 状态：', txt(stats));
await client.close();

console.log('\n[5] 降级测试：把嵌入服务指向不存在的端口');
const dead = await makeClient('http://127.0.0.1:1/v1/embeddings');
const r2 = await dead.callTool({ name: 'memory_recall', arguments: { query: '猫', limit: 3 } });
const b2 = txt(r2);
console.log(b2.split('\n')[0]);
console.log('    是否降级到字面：', /字面检索/.test(b2) ? '✓' : '✗');
console.log('    内容是否仍返回：', b2.includes('豆豆') ? '✓' : '✗');
await dead.close();

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n[6] 已清理临时目录');
process.exit(pass === CASES.length ? 0 : 1);
