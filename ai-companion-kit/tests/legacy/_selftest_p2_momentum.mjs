import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// P2 自证：动量（非线性增长 + 时间衰减 + 参与排序）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { momentumOf, bump, rankScore, K, DECAY_DAYS } from 'pathToFileURL(path.join(REPO_ROOT, "/qq-bridge/src/inori-momentum.js")).href';

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  PASS', name); } catch (e) { fail++; console.log('  FAIL', name, '—', e.message); } };

const NOW = 1792752000000;
const DAY = 86400000;
const mk = (mentions, lastMentionAt = NOW) => ({ mentions, lastMentionAt });

// ── 曲线
check('提 10 次显著高于提 1 次', () => {
  const a = momentumOf(mk(1), NOW);
  const b = momentumOf(mk(10), NOW);
  assert.ok(b > a + 0.5, `1次=${a} 10次=${b}`);
});

check('非线性：1→3 的增幅大于 3→10 的平均增幅', () => {
  const m1 = momentumOf(mk(1), NOW), m3 = momentumOf(mk(3), NOW), m10 = momentumOf(mk(10), NOW);
  const early = m3 - m1;
  const late = (m10 - m3) / 7;
  assert.ok(early > late, `早期增幅 ${early.toFixed(3)} 应大于后期平均 ${late.toFixed(3)}`);
});

check('上界 ≤1', () => assert.ok(momentumOf(mk(1000), NOW) <= 1));

check('没记录过提及 → 0', () => assert.strictEqual(momentumOf({}, NOW), 0));

// ── 衰减
check('久不提会回落：同样 3 次，30 天前提的低于刚提的', () => {
  const fresh = momentumOf(mk(3, NOW), NOW);
  const stale = momentumOf(mk(3, NOW - 30 * DAY), NOW);
  assert.ok(stale < fresh, `fresh=${fresh} stale=${stale}`);
});

check('两个衰减周期后更低', () => {
  const one = momentumOf(mk(5, NOW - DECAY_DAYS * DAY), NOW);
  const two = momentumOf(mk(5, NOW - DECAY_DAYS * 2 * DAY), NOW);
  assert.ok(two < one, `1周期=${one} 2周期=${two}`);
});

// ── bump
check('bump 累加 mentions 并刷新时间', () => {
  const e = { mentions: 2, lastMentionAt: NOW - 10 * DAY };
  bump(e, NOW);
  assert.strictEqual(e.mentions, 3);
  assert.strictEqual(e.lastMentionAt, NOW);
  assert.ok(e.momentum > 0);
});

// ── 排序
check('同样相似度下，动量高的排前面', () => {
  const hi = rankScore({ similarity: 0.6, momentum: 0.86, lastAt: NOW }, NOW);
  const lo = rankScore({ similarity: 0.6, momentum: 0.18, lastAt: NOW }, NOW);
  assert.ok(hi > lo, `${hi} 应 > ${lo}`);
});

check('动量不能压过相关性太多：低相似高动量仍低于高相似低动量', () => {
  const a = rankScore({ similarity: 0.9, momentum: 0.1, lastAt: NOW }, NOW);
  const b = rankScore({ similarity: 0.45, momentum: 0.86, lastAt: NOW }, NOW);
  assert.ok(a > b, `高相似=${a} 应 > 低相似高动量=${b}`);
});

// ── MCP 端到端：同一件事提三次，只留一条、mentions=3
const TMP = path.join(os.tmpdir(), 'p2-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const client = new Client({ name: 'p2', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//memory-mcp//src//memory-mcp.js")],
  env: { ...process.env, MEMORY_DIR: TMP, SKILLS_FILE: path.join(TMP, 's.json'), TRACES_DIR: path.join(TMP, 't') },
}));
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  return { err: !!r.isError, txt: (r.content ?? []).map((c) => c.text ?? '').join(' ') };
};

const r1 = await call('memory_save', { text: '他说下周一生日' });
const r2 = await call('memory_save', { text: '他说下周一生日' });
const r3 = await call('memory_save', { text: '他说下周一生日' });
check('重复提到三次 → 只留一条记忆', () => {
  const lines = fs.readFileSync(path.join(TMP, 'memory.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, '实际 ' + lines.length + ' 条');
});
check('第三次返回「又提了一次（第 3 次）」', () => {
  assert.ok(r3.txt.includes('第 3 次'), r3.txt);
});
check('条目里 mentions=3 且有 momentum', () => {
  const row = JSON.parse(fs.readFileSync(path.join(TMP, 'memory.jsonl'), 'utf8').trim());
  assert.strictEqual(row.mentions, 3);
  assert.ok(typeof row.momentum === 'number' && row.momentum > 0);
});

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
