#!/usr/bin/env node
// 技能体检（固定评估集 + 结构指标）：只读、零 LLM。
//
// 用法：node scripts/eval-skills.mjs [--json] [--strict]
//
// 固定评估集：把「她会遇到的任务」写成 query，用 bigramCoverage 在 name+desc 上排序前 3，
// 看期望技能是否命中——只证明「检索得到」，不证明「做得成」。做得成看 attempts/ok/verify。
import fs from 'node:fs';
import { bigramCoverage } from '../src/domain/memory/memory-retrieve.js';
import { stateDataPath } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const FILE = stateDataPath('skills.json');

const CASES = [
  { query: '商店只有预约按钮怎么装游戏', expect: '商店只有预约' },
  { query: '明日方舟怎么把干员放到场上', expect: '部署干员' },
  { query: '基建怎么赚龙门币', expect: '龙门币' },
  { query: '画世界怎么导出图发QQ', expect: '导出图片' },
  { query: '怎么在手机画笔上画心形', expect: '画笔' },
];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch { return []; }
}

const items = load().filter((s) => s && String(s.name ?? '').trim());
const hay = (s) => `${s.name ?? ''} ${s.desc ?? ''}`;

const cases = CASES.map((c) => {
  if (!items.some((s) => hay(s).includes(c.expect))) return { ...c, status: 'skipped' };
  const ranked = items
    .map((s) => ({ s, score: bigramCoverage(c.query, hay(s)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const hit = ranked.some((r) => hay(r.s).includes(c.expect));
  return { ...c, status: hit ? 'hit' : 'miss' };
});
const scored = cases.filter((c) => c.status !== 'skipped');
const hits = scored.filter((c) => c.status === 'hit').length;
const hitRate = scored.length ? hits / scored.length : 0;

const withVerify = items.filter((s) => String(s.verify ?? '').trim());
const neverTried = items.filter((s) => !Number(s.attempts));
const attemptedFail = items.filter((s) => Number(s.attempts) > 0 && s.ok === false);
const retired = items.filter((s) => s.retired);

const report = {
  total: items.length,
  withVerify: withVerify.length,
  neverTried: neverTried.length,
  attemptedFail: attemptedFail.length,
  retired: retired.length,
  recall: { cases: scored.length, hits, hitRate: Math.round(hitRate * 1000) / 1000, detail: cases },
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log('=== 技能体检 ===');
  console.log(`条数 ${report.total}｜有判据 ${report.withVerify}｜没试过 ${report.neverTried}｜试过未成 ${report.attemptedFail}｜已退役 ${report.retired}`);
  console.log(`\n固定评估集（name+desc 字面 hit@3）：${hits}/${scored.length} = ${(hitRate * 100).toFixed(0)}%`);
  for (const c of cases) {
    console.log(`  ${c.status === 'hit' ? '✅' : c.status === 'miss' ? '❌' : '⚪'} ${c.query}${c.status === 'skipped' ? '（期望片段已不在库中，跳过）' : ''}`);
  }
}

if (strict && scored.length && hitRate < 0.6) {
  console.error('\n技能固定评估集低于底线（<60%）');
  process.exitCode = 1;
}
