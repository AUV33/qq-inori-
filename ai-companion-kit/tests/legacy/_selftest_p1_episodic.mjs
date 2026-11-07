import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// P1 自证：记忆写成「情节」，读出来是叙事而不是字段
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatEntry, recallBlock } from 'pathToFileURL(path.join(REPO_ROOT, "/qq-bridge/src/memory-retrieve.js")).href';

const TMP = path.join(os.tmpdir(), 'p1-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
};

// 格式化（纯函数）
check('有 felt/theme：输出带「当时」和主题', () => {
  const s = formatEntry({ time: '2026-10-23 13:42', text: '他说下周一生日', felt: '记住了，怕忘', theme: '生日' });
  assert.ok(s.includes('当时：记住了，怕忘'), s);
  assert.ok(s.includes('#生日'), s);
});

check('无 felt/theme：退化成原来的形式（旧数据兼容）', () => {
  const s = formatEntry({ time: '2026-10-23 13:42', text: '他说下周一生日' });
  assert.strictEqual(s, '2026-10-23 13:42｜他说下周一生日');
});

check('who 是他：不重复加前缀', () => {
  const s = formatEntry({ time: 't', text: 'x', who: '他' });
  assert.ok(!s.includes('他：'), s);
});

check('who 是别人：加前缀', () => {
  const s = formatEntry({ time: 't', text: '说了句怪话', who: '群友A' });
  assert.ok(s.includes('群友A：'), s);
});

// 通过 MCP 写入带情节字段的记忆，再确认落盘
const client = new Client({ name: 'p1-e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: TMP, SKILLS_FILE: path.join(TMP, 's.json'), TRACES_DIR: path.join(TMP, 't') },
}));
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  return { err: !!r.isError, txt: (r.content ?? []).map((c) => c.text ?? '').join(' ') };
};

const save = await call('memory_save', {
  text: '他说下周一生日',
  felt: '记住了，怕忘',
  theme: '生日',
  who: '他',
});
check('memory_save 接收情节字段并回显', () => {
  assert.ok(!save.err, save.txt);
  assert.ok(save.txt.includes('带了自己的感受'), save.txt);
});

const file = path.join(TMP, 'memory.jsonl');
const row = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
check('落盘含 felt/theme 字段', () => {
  assert.strictEqual(row.felt, '记住了，怕忘');
  assert.strictEqual(row.theme, '生日');
});

const rec = await call('memory_recall', { query: '生日' });
check('召回输出是叙事而非裸文本', () => {
  assert.ok(rec.txt.includes('当时：记住了，怕忘'), rec.txt);
  assert.ok(rec.txt.includes('#生日'), rec.txt);
});

// 桥接侧注入块同样用叙事
const block = await recallBlock('生日', { dir: TMP, limit: 3 });
check('recallBlock 注入文本是叙事', () => {
  assert.ok(block.text.includes('当时：'), block.text);
});

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
