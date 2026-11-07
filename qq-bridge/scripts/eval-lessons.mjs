#!/usr/bin/env node
// 经验体检（固定评估集 + 结构指标）：只读、零 LLM。
//
// 用法：node scripts/eval-lessons.mjs [--json] [--strict]
//
// 固定评估集用 bigramCoverage 排序前 5，看期望经验是否命中——只证明「字面可检的下限」，
// 不冒充语义质量。结构指标看：从没被用过的、低置信、重复、kind 分布。
import fs from 'node:fs';
import path from 'node:path';
import { bigramCoverage } from '../src/domain/memory/memory-retrieve.js';
import { stateDataPath } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const FILE = stateDataPath('lessons.jsonl');

const CASES = [
  { query: '他说我可以玩手机我该怎么做', expect: '真的动手玩' },
  { query: '他一直盯着我在干嘛', expect: '旁边看屏幕' },
  { query: '他催我怎么不动手机是什么意思', expect: '让我自己动手' },
  { query: '锁卡住了反复重试有用吗', expect: 'wait 锁卡住' },
  { query: '他让我自己找答案', expect: '自己找' },
];

function load() {
  const rows = [];
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return rows; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 跳坏行 */ }
  }
  return rows;
}

const items = load();
const usable = items.filter((l) => String(l.text ?? '').trim());

const cases = CASES.map((c) => {
  if (!usable.some((l) => String(l.text).includes(c.expect))) return { ...c, status: 'skipped' };
  const ranked = usable
    .map((l) => ({ l, score: bigramCoverage(c.query, String(l.text)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const hit = ranked.some((r) => String(r.l.text).includes(c.expect));
  return { ...c, status: hit ? 'hit' : 'miss' };
});
const scored = cases.filter((c) => c.status !== 'skipped');
const hits = scored.filter((c) => c.status === 'hit').length;
const hitRate = scored.length ? hits / scored.length : 0;

const neverUsed = usable.filter((l) => !Number(l.hits) && !l.usedAt);
const lowConfidence = usable.filter((l) => Number(l.confidence ?? 1) < 0.5);
const byKind = {};
for (const l of usable) byKind[l.kind || 'unknown'] = (byKind[l.kind || 'unknown'] || 0) + 1;
const texts = usable.map((l) => String(l.text).trim());
const dup = texts.length - new Set(texts).size;

const report = {
  total: usable.length,
  neverUsed: neverUsed.length,
  lowConfidence: lowConfidence.length,
  duplicates: dup,
  byKind,
  recall: { cases: scored.length, hits, hitRate: Math.round(hitRate * 1000) / 1000, detail: cases },
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log('=== 经验体检 ===');
  console.log(`条数 ${report.total}｜从没用过 ${report.neverUsed}｜低置信(<0.5) ${report.lowConfidence}｜重复 ${dup}`);
  console.log('按 kind:', Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join('  ') || '（空）');
  console.log(`\n固定评估集（字面打分 hit@5）：${hits}/${scored.length} = ${(hitRate * 100).toFixed(0)}%`);
  for (const c of cases) {
    console.log(`  ${c.status === 'hit' ? '✅' : c.status === 'miss' ? '❌' : '⚪'} ${c.query}${c.status === 'skipped' ? '（期望片段已不在库中，跳过）' : ''}`);
  }
}

if (strict && scored.length && hitRate < 0.6) {
  console.error('\n经验固定评估集低于底线（<60%）');
  process.exitCode = 1;
}
