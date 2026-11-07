// freedom-report.mjs · 自由度观测报告 + 监控器自检
//
// 用法：node scripts/freedom-report.mjs [--strict]
// 读 state/freedom-log.jsonl，输出最近 24h 的分布、预算耗尽次数、监控健康。
// --strict 时 health 不通过返回 1，可直接接 watchdog / CI。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeFreedom, checkFreedomMonitor, formatFreedomSummary } from '../src/domain/social/freedom-monitor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'freedom-log.jsonl');
const strict = process.argv.includes('--strict');

let rows = [];
try {
  rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
} catch { rows = []; }

const summary = summarizeFreedom(rows);
const health = checkFreedomMonitor(rows, { now: Date.now() });
console.log(formatFreedomSummary(summary, health));
if (rows.length) {
  const last = rows.slice(-5);
  console.log('最近 5 条：');
  for (const r of last) {
    console.log(`  ${r.at} ${r.key} trust=${r.trust} reply=${r.reply} initiate=${r.initiate}(${r.initiateRemaining}) explore=${r.explore}(${r.exploreRemaining}) selfEdit=${r.selfEdit} manageGroup=${r.manageGroup}`);
  }
}
if (strict && !health.ok) process.exit(1);
