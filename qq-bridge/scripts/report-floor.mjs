// report-floor.mjs · 读 data/state/floor-decisions.jsonl，按 reason/时段/群统计「该不该开口」
//
// 为什么要有它：turn-taking 的阈值、实测间隔分位、自适应被接住率都靠真实数据调，
// 但判定日志是 JSONL，用眼睛看不出分布。这里只做只读统计，不改任何状态。
//
// 用法：
//   node scripts/report-floor.mjs [--days 2] [--key group:123456789] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDataPath } from '../src/domain/shared/project-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = stateDataPath('floor-decisions.jsonl');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const days = Number(getArg('--days', 2));
const keyFilter = getArg('--key', '');
const asJson = args.includes('--json');

if (!fs.existsSync(FILE)) {
  console.error(`没有判定日志：${FILE}\n等桥接跑一段时间后再看（重启后每次 floor 判定都会写一行）。`);
  process.exit(2);
}

const since = Date.now() - days * 24 * 3600 * 1000;
const rows = fs.readFileSync(FILE, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => !keyFilter || r.key === keyFilter)
  .filter((r) => { const t = Date.parse(r.at); return !Number.isFinite(t) || t >= since; });

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const group = (f) => rows.reduce((m, r) => { const k = f(r) ?? '?'; m[k] ??= []; m[k].push(r); return m; }, {});

const summary = (list) => {
  const total = list.length;
  const woke = list.filter((r) => r.wake === true).length;
  const directed = list.filter((r) => r.directed === true).length;
  const adaptive = list.filter((r) => Number.isFinite(r.minReply) && r.minReply !== 0.22).length;
  const withHit = list.filter((r) => Number.isFinite(r.hitRate));
  const avgHit = withHit.length ? withHit.reduce((a, r) => a + r.hitRate, 0) / withHit.length : null;
  const avgReply = total ? list.reduce((a, r) => a + (Number(r.reply) || 0), 0) / total : 0;
  return {
    total,
    woke,
    wakeRate: total ? woke / total : 0,
    directedRate: total ? directed / total : 0,
    adaptiveRate: total ? adaptive / total : 0,
    avgReply: Number(avgReply.toFixed(3)),
    avgHitRate: avgHit == null ? null : Number(avgHit.toFixed(3)),
    hitSamples: withHit.length,
  };
};

const out = {
  file: FILE,
  windowDays: days,
  overall: summary(rows),
  byReason: Object.fromEntries(Object.entries(group((r) => r.reason)).map(([k, v]) => [k, summary(v)])),
  byHour: Object.fromEntries(Object.entries(group((r) => r.hour)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, summary(v)])),
  byKey: Object.fromEntries(Object.entries(group((r) => r.key)).map(([k, v]) => [k, summary(v)])),
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const line = (label, s) => `${label.padEnd(12)} n=${String(s.total).padStart(4)}  开口率=${pct(s.woke, s.total).padStart(4)}  点名率=${pct(Math.round(s.directedRate * s.total), s.total)}  自适应=${pct(s.adaptiveRate, s.total)}  平均reply=${s.avgReply}`;
console.log(`floor 判定统计（最近 ${days} 天${keyFilter ? `，${keyFilter}` : ''}）`);
console.log(line('全部', out.overall));
if (out.overall.avgHitRate != null) console.log(`  缓冲区估计的被接住率均值=${out.overall.avgHitRate}（样本 ${out.overall.hitSamples} 次判定带样本）`);
console.log('\n按 reason：');
for (const [k, s] of Object.entries(out.byReason).sort((a, b) => b[1].total - a[1].total)) console.log('  ' + line(k, s));
console.log('\n按群：');
for (const [k, s] of Object.entries(out.byKey)) console.log('  ' + line(k, s));
console.log('\n按小时（开口率）：');
const hours = Object.entries(out.byHour);
console.log('  ' + hours.map(([h, s]) => `${h}h:${pct(s.woke, s.total)}(${s.total})`).join('  '));
