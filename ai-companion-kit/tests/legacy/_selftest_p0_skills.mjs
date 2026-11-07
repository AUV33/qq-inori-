import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// P0 端到端：经 MCP 走完「存技能 → 检索 → 记结果 → 记经验」闭环
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'p0-mcp-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const client = new Client({ name: 'p0-e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: {
    ...process.env,
    MEMORY_DIR: TMP,
    GOALS_FILE: path.join(TMP, 'goals.json'),
    SKILLS_FILE: path.join(TMP, 'skills.json'),
    TRACES_DIR: path.join(TMP, 'traces'),
  },
}));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, txt: (r.content ?? []).map((c) => c.text ?? '').join(' ') };
};

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

// 1. 存技能
const a = await call('skill_save', {
  name: '商店只有预约时去官网装',
  desc: '应用商店里只有预约按钮，不代表装不了，去官网下 apk',
  steps: ['打开商店搜名字', '看到预约按钮就停下', '去官网找下载页'],
  verify: '屏幕上出现开始游戏或打开',
  tags: ['安卓', '安装'],
});
ok(!a.err && a.txt.includes('学会了新技能'), 'skill_save 新建', a.txt);

// 2. 同名再存 → 更新
const b = await call('skill_save', {
  name: '商店只有预约时去官网装',
  desc: '改过的说明',
  steps: ['直接去官网'],
});
ok(!b.err && b.txt.includes('更新了技能'), 'skill_save 同名更新', b.txt);

// 3. 检索
const c = await call('skill_find', { query: '装个游戏' });
ok(!c.err && c.txt.includes('商店只有预约'), 'skill_find 命中', c.txt);
const d = await call('skill_find', { query: '量子力学' });
ok(!d.err && d.txt.includes('没有能用的'), 'skill_find 无关返回空', d.txt);

// 4. 记结果（成功）
const idMatch = /\[(s[0-9a-f]+)\]/.exec(c.txt);
ok(!!idMatch, 'skill_find 返回 id');
if (idMatch) {
  const e = await call('skill_record', { id: idMatch[1], ok: true });
  ok(!e.err && e.txt.includes('成功 1'), 'skill_record 成功计数', e.txt);
  const f = await call('skill_record', { id: idMatch[1], ok: false });
  ok(!f.err && f.txt.includes('失败 1'), 'skill_record 失败计数', f.txt);
}

// 5. 经验池
const g = await call('trace_log', { goal: '装上明日方舟', result: 'fail', steps: ['打开商店', '看到预约'], error: '只有预约按钮' });
ok(!g.err && g.txt.includes('成功率'), 'trace_log 记失败', g.txt);
const h = await call('trace_log', { goal: '装上明日方舟', result: 'success', note: '从官网装上了' });
ok(!h.err && h.txt.includes('50%'), 'trace_log 成功率 50%', h.txt);

// 6. 落盘校验
ok(fs.existsSync(path.join(TMP, 'skills.json')), 'skills.json 已落盘');
const traces = fs.readdirSync(path.join(TMP, 'traces'));
ok(traces.length === 1, 'traces 按天一个文件（实际 ' + traces.length + '）');

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
