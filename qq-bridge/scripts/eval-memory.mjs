#!/usr/bin/env node
// 记忆体检（固定评估集 + 结构指标）：只读、零 LLM。
//
// 用法：
//   node scripts/eval-memory.mjs            # 人看
//   node scripts/eval-memory.mjs --json     # 机器读
//   node scripts/eval-memory.mjs --strict   # 命中率低于底线时退出码 1
//
// 两件事分开看：
//   1. 固定评估集：6 个真实问题 → 用 bigramCoverage（纯函数，和检索同一套字面打分）排序，
//      期望的记忆是否进前 5。这是**字面可检的下限**，不代表语义检索好，但能抓「越改越差」。
//   2. 结构指标：总量、按 scope、近 7 天新增、重复文本、缺字段。
import fs from 'node:fs';
import path from 'node:path';
import { bigramCoverage } from '../src/domain/memory/memory-retrieve.js';
import { MEMORY_DIR } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');

// 固定评估集：query → 期望片段（片段必须能在某条记忆里出现，否则该 case 记为 skipped）
const CASES = [
  { query: '主人的生日是哪天', expect: '生日' },
  { query: '方舟基建怎么搓龙门币', expect: '贸易站' },
  { query: '上次基建干到一半卡在哪', expect: '基建活干了一半' },
  { query: '他让我玩手机是什么意思', expect: '玩手机' },
  { query: '画世界怎么把画发到QQ', expect: '画世界' },
  { query: '手机 adb 掉线了怎么办', expect: 'adb' },
];

function memoryFiles() {
  const out = [];
  try {
    for (const name of fs.readdirSync(MEMORY_DIR)) {
      if (/^memory.*\.jsonl$/i.test(name)) out.push(path.join(MEMORY_DIR, name));
    }
  } catch { /* 目录不存在 */ }
  return out;
}

function loadAll() {
  const rows = [];
  for (const file of memoryFiles()) {
    const scope = path.basename(file).replace(/^memory-?/, '').replace(/\.jsonl$/i, '').replace(/^-/, '') || 'private';
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        rows.push({ ...e, scope, file: path.basename(file) });
      } catch { /* 坏行跳过 */ }
    }
  }
  return rows;
}

const entries = loadAll();
const usable = entries.filter((e) => String(e.text ?? '').trim());

const cases = CASES.map((c) => {
  const expectedExists = usable.some((e) => String(e.text).includes(c.expect));
  if (!expectedExists) return { ...c, status: 'skipped' };
  const ranked = usable
    .map((e) => ({ e, score: bigramCoverage(c.query, String(e.text)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const hit = ranked.some((r) => String(r.e.text).includes(c.expect));
  return { ...c, status: hit ? 'hit' : 'miss', top: ranked.map((r) => Math.round(r.score * 1000) / 1000) };
});

const scored = cases.filter((c) => c.status !== 'skipped');
const hits = scored.filter((c) => c.status === 'hit').length;
const hitRate = scored.length ? hits / scored.length : 0;

const now = Date.now();
const DAY = 24 * 3600 * 1000;
const recent7 = usable.filter((e) => {
  const t = Date.parse(e.time ?? e.at ?? e.day ?? '');
  return Number.isFinite(t) && now - t <= 7 * DAY;
});
const byScope = {};
for (const e of usable) byScope[e.scope] = (byScope[e.scope] || 0) + 1;
const texts = usable.map((e) => String(e.text).trim());
const dup = texts.length - new Set(texts).size;
const missingKind = usable.filter((e) => !e.kind).length;

const report = {
  entries: entries.length,
  usable: usable.length,
  byScope,
  recent7: recent7.length,
  duplicates: dup,
  missingKind,
  recall: { cases: scored.length, hits, hitRate: Math.round(hitRate * 1000) / 1000, detail: cases },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== 记忆体检 ===');
  console.log(`条数 ${report.usable}/${report.entries}｜近 7 天新增 ${report.recent7}｜重复文本 ${dup}｜缺 kind ${missingKind}`);
  console.log('按 scope:', Object.entries(byScope).map(([k, v]) => `${k}:${v}`).join('  ') || '（空）');
  console.log(`\n固定评估集（字面打分 hit@5）：${hits}/${scored.length} = ${(hitRate * 100).toFixed(0)}%`);
  for (const c of cases) {
    const mark = c.status === 'hit' ? '✅' : c.status === 'miss' ? '❌' : '⚪';
    console.log(`  ${mark} ${c.query}${c.status === 'skipped' ? '（期望片段已不在库中，跳过）' : ''}`);
  }
}

const bottomLine = 0.6;
if (strict && scored.length && hitRate < bottomLine) {
  console.error(`\n记忆固定评估集低于底线（${(hitRate * 100).toFixed(0)}% < ${bottomLine * 100}%）`);
  process.exitCode = 1;
}
