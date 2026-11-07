#!/usr/bin/env node
// 认知体检：只读、零 LLM，纯结构指标。
//
// 用法：
//   node scripts/eval-cognition.mjs           # 人看的报告
//   node scripts/eval-cognition.mjs --json    # 机器用
//   node scripts/eval-cognition.mjs --strict  # 低于底线时退出码 1（可挂进审计）
//
// 看四件事：
//   1. 覆盖：现有认知分到哪几类（全挤在 about-him 就是"只会说人话"）
//   2. 依据：多少条挂了 evidence（没依据的判断，被推翻时你都不知道该改哪条）
//   3. 使用：多少条从没被注入过（neverUsed → 写了也没用上）
//   4. 老化：低置信 + 无依据 + 放了很久的老条目（该验证或该退休）
import { load, stats, KINDS, KIND_LABEL } from '../src/domain/leaves/inori-cognition.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');

const items = load();
const s = stats(items);
const now = Date.now();
const DAY = 24 * 3600 * 1000;

const active = items.filter((x) => x && !x.invalidAt);
const missingKind = KINDS.filter((k) => k !== 'general' && !active.some((x) => x.kind === k));
const noEvidence = active.filter((x) => !Array.isArray(x.evidence) || !x.evidence.length);
const neverUsed = active.filter((x) => !x.usedCount);
const stale = active.filter((x) => {
  const at = Date.parse(x.validAt || x.at || '');
  if (!Number.isFinite(at)) return false;
  const old = now - at > 14 * DAY;
  const weak = (Number(x.confidence) || 0.55) < 0.6;
  const bare = !Array.isArray(x.evidence) || !x.evidence.length;
  return old && weak && bare;
});

const report = {
  file: `${PROJECT_ROOT}/data/state/cognition.jsonl`,
  stats: s,
  kindCoverage: Object.fromEntries(KINDS.map((k) => [k, active.filter((x) => x.kind === k).length])),
  missingKind,
  activeWithoutEvidence: noEvidence.length,
  neverUsed: neverUsed.length,
  stale: stale.map((x) => ({ id: x.id, kind: x.kind, text: String(x.text).slice(0, 40), confidence: x.confidence })),
  lowConfidence: active.filter((x) => (Number(x.confidence) || 0.55) < 0.5).map((x) => x.id),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== 认知体检 ===');
  console.log(`总数 ${s.total}｜有效 ${s.active}｜已失效 ${s.invalid}｜平均置信 ${s.avgConfidence}`);
  console.log('');
  console.log('分类覆盖：');
  for (const k of KINDS) {
    const n = report.kindCoverage[k];
    const mark = n ? '✓' : '·';
    console.log(`  ${mark} ${KIND_LABEL[k].padEnd(4, '　')} ${String(n).padStart(2)}  ${'█'.repeat(Math.min(20, n))}`);
  }
  console.log('');
  console.log(`有依据的：${s.active - report.activeWithoutEvidence}/${s.active}`);
  console.log(`从没被注入过的：${report.neverUsed}/${s.active}`);
  console.log(`可疑老化（低置信+无依据+超14天）：${report.stale.length}`);
  if (report.stale.length) for (const x of report.stale) console.log(`  - ${x.id} [${x.kind}] ${x.text}（置信 ${x.confidence}）`);
  console.log('');
  if (missingKind.length) console.log(`缺口：${missingKind.map((k) => KIND_LABEL[k]).join('、')} 一条都没有`);
  if (!s.active) console.log('提示：一条有效认知都没有——先让反思轮写一条。');
  if (report.activeWithoutEvidence) console.log('提示：没依据的判断，被推翻时不知道该改哪条，写的时候顺手带 evidence。');
}

if (strict) {
  const bad = s.active === 0 || report.missingKind.length >= 4;
  process.exit(bad ? 1 : 0);
}
