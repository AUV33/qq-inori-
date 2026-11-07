// 记忆库体检（只读）：条数/kind/重复/近似重复/主题缺失/认知沉淀落点
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const DIR = `${PROJECT_ROOT}/data/memory`;
const FILES = ['memory.jsonl', 'memory-group_123456789.jsonl', 'memory-group_123456780.jsonl'];

function bigrams(t) {
  const s = String(t || '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

for (const f of FILES) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) { console.log(f, '不存在'); continue; }
  const rows = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const kinds = {};
  for (const r of rows) kinds[r.kind || '-'] = (kinds[r.kind || '-'] || 0) + 1;
  const noTheme = rows.filter((r) => !r.theme).length;
  // 完全相同（去空白）
  const norm = (t) => String(t || '').replace(/\s+/g, '');
  const exact = new Map();
  for (const r of rows) { const k = norm(r.text); exact.set(k, (exact.get(k) || 0) + 1); }
  const exactDup = [...exact.values()].filter((n) => n > 1).reduce((a, b) => a + b - 1, 0);
  // 近似重复（二元组 jaccard ≥ 0.8，长度 ≥ 20 字）
  const grams = rows.map((r) => bigrams(r.text));
  const near = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i].text || '').length < 20) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const s = jaccard(grams[i], grams[j]);
      if (s >= 0.8) near.push({ i, j, s: +s.toFixed(2), a: String(rows[i].text).slice(0, 40), b: String(rows[j].text).slice(0, 40) });
    }
  }
  console.log(`\n## ${f}`);
  console.log(`  条数 ${rows.length} | kind ${JSON.stringify(kinds)}`);
  console.log(`  无 theme 字段 ${noTheme} 条（${Math.round(noTheme / rows.length * 100)}%）`);
  console.log(`  完全重复 ${exactDup} 条`);
  console.log(`  近似重复（≥0.8） ${near.length} 对`);
  for (const n of near.slice(0, 4)) console.log(`    ${n.s}  「${n.a}」 ≈ 「${n.b}」`);
}

// 认知沉淀落点
const ins = `${PROJECT_ROOT}/data/state/insights.jsonl`;
const insSize = fs.existsSync(ins) ? fs.readFileSync(ins, 'utf8').trim() : '';
console.log('\n## insights.jsonl（认知沉淀落点）');
console.log('  内容:', insSize ? insSize.slice(0, 120) : '（空）');
// 结构化字段覆盖
const priv = fs.readFileSync(path.join(DIR, 'memory.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fields = {};
for (const r of priv) for (const k of Object.keys(r)) fields[k] = (fields[k] || 0) + 1;
console.log('\n## 私聊记忆字段覆盖（共', priv.length, '条）');
console.log(' ', JSON.stringify(fields));
