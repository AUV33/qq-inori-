#!/usr/bin/env node
// 表达趋势报表（只读）：node scripts/style-trend.mjs [--days=7] [--json]
// 读 data/state/style-profile.jsonl，对比「今天」与「之前 N 天」：她自己 vs 场合。
// 注意：只有平均句长/短句率有「目标值」（target.targetAvg / targetShort）；
// 问句率/表情率/语气词率/多逗号率 只有场合实测值（scene.*），没有换算成目标——这是已知缺口，报表里如实标出。
// 纪律：只报机器可算的差值，不做"更自然/更像人"这类判断。
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const file = `${PROJECT_ROOT}/data/state/style-profile.jsonl`;
const days = Math.max(1, Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 7);
const asJson = process.argv.includes('--json');
const pad = (n, w = 8) => String(n).padStart(w);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
const round = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : NaN);

const rows = (() => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
})();
if (!rows.length) { console.log('还没有 style-profile 数据（桥接会在每次唤醒时写入）'); process.exit(0); }

const dayOf = (r) => String(r.day || (r.at || '').slice(0, 10));
const allDays = [...new Set(rows.map(dayOf))].sort();
const today = allDays[allDays.length - 1];
const baselineDays = allDays.slice(0, -1).slice(-days);

const pick = (rs, path) => avg(rs.map((r) => {
  let v = r; for (const k of path.split('.')) v = v?.[k];
  const n = Number(v); return Number.isFinite(n) ? n : NaN;
}).filter(Number.isFinite));
const verdicts = (rs) => { const o = {}; for (const r of rs) o[r.verdict] = (o[r.verdict] || 0) + 1; return o; };

const A = rows.filter((r) => dayOf(r) === today);
const B = rows.filter((r) => baselineDays.includes(dayOf(r)));

// [维度, 我的取值路径, 场合取值路径, 场合是否只是实测（没有目标）]
const DIMS = [
  ['平均句长(字)', 'mine.avgLen', 'target.targetAvg', false],
  ['短句率', 'mine.shortRatio', 'target.targetShort', false],
  ['问句率', 'mine.questionRate', 'scene.questionRate', true],
  ['表情率', 'mine.emojiRate', 'scene.emojiRate', true],
  ['语气词率', 'mine.particleRate', 'scene.particleRate', true],
  ['多逗号长句率', 'mine.multiCommaRatio', 'scene.multiCommaRatio', true],
];

const out = {
  today, todaySamples: A.length, baselineDays, baselineSamples: B.length,
  verdictsToday: verdicts(A), verdictsBaseline: verdicts(B), dims: [],
};
for (const [label, minePath, scenePath, sceneOnly] of DIMS) {
  const row = {
    label,
    todayMine: round(pick(A, minePath)), baselineMine: round(pick(B, minePath)),
    todayScene: round(pick(A, scenePath)), baselineScene: round(pick(B, scenePath)),
    sceneOnly,
  };
  row.deltaMine = Number.isFinite(row.todayMine) && Number.isFinite(row.baselineMine) ? round(row.todayMine - row.baselineMine) : NaN;
  row.gapToday = Number.isFinite(row.todayMine) && Number.isFinite(row.todayScene) ? round(row.todayMine - row.todayScene) : NaN;
  out.dims.push(row);
}
// 逐条 gap 的分布：平均值会互相抵消，要能看出偏长偏短各多少
const gaps = A.map((r) => Number(r.gap)).filter(Number.isFinite);
out.gapDist = {
  avg: round(avg(gaps)),
  n: gaps.length,
  long: gaps.filter((g) => g > 0).length,
  short: gaps.filter((g) => g < 0).length,
  zero: gaps.filter((g) => g === 0).length,
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`# 表达趋势：今天 ${today}（${A.length} 条） vs 前 ${baselineDays.length} 天（${B.length} 条）`);
console.log('维度'.padEnd(16) + pad('今天·我') + pad('基线·我') + pad('变化') + pad('今天·场合') + pad('我与场合差') + pad('场合口径'));
for (const d of out.dims) {
  console.log(d.label.padEnd(16)
    + pad(d.todayMine ?? '—') + pad(d.baselineMine ?? '—')
    + pad(Number.isFinite(d.deltaMine) ? (d.deltaMine > 0 ? '+' + d.deltaMine : d.deltaMine) : '—')
    + pad(d.todayScene ?? '—') + pad(d.gapToday ?? '—')
    + pad(d.sceneOnly ? '实测(无目标)' : '目标'));
}
console.log('');
const fmt = (v) => Object.entries(v).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';
console.log(`判定：今天 ${fmt(out.verdictsToday)} | 基线 ${fmt(out.verdictsBaseline)}`);
console.log(`逐条句长差：平均 ${out.gapDist.avg} 字（偏长 ${out.gapDist.long} / 偏短 ${out.gapDist.short} / 正好 ${out.gapDist.zero}，共 ${out.gapDist.n}）`);
