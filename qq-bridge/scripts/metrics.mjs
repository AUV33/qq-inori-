#!/usr/bin/env node
// metrics.mjs · 行为指标（只读）：回复延迟 / 重复率 / 未读积压 / 唤醒 / token
//
// 用法：
//   node scripts/metrics.mjs              # 24h 人读
//   node scripts/metrics.mjs --hours 72
//   node scripts/metrics.mjs --json       # 机器读
//
// 数据源：state/social-v2.json（recentMessages/wakeTimes/unread）+ state/token-usage.jsonl。
// 口径提醒：recentMessages 有上限，是"最近窗口内的近似值"，不是全量统计。
import fs from 'node:fs';
import path from 'node:path';
import { computeMetrics } from '../src/domain/shared/runtime-metrics.js';
import { bridgePath, stateDataPath } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const hoursArg = argv.indexOf('--hours');
const hours = hoursArg >= 0 ? Math.max(1, Number(argv[hoursArg + 1]) || 24) : 24;

const state = JSON.parse(fs.readFileSync(bridgePath('state', 'social-v2.json'), 'utf8'));
const conversations = new Map(Object.entries(state?.conversations ?? {}));

const tokenRows = [];
for (const file of [path.join(stateDataPath(' '), '..', '..', 'qq-bridge', 'state', 'token-usage.jsonl'), bridgePath('state', 'token-usage.jsonl')]) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { tokenRows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    break;
  } catch { /* 下一个候选 */ }
}

const report = computeMetrics({ conversations, tokenRows, windowMs: hours * 3600 * 1000 });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`=== 近 ${report.windowHours} 小时 ===`);
  console.log(`入站 ${report.totals.incoming} · 出站 ${report.totals.outgoing} · 唤醒 ${report.totals.wakes} · 未读 ${report.totals.unread}`);
  console.log(`重复出站 ${report.totals.duplicateSelf} 条（重复率 ${(report.totals.duplicateRate * 100).toFixed(1)}%）`);
  console.log(`token：${report.tokens.turns} 轮，输入 ${report.tokens.inputTokens}，输出 ${report.tokens.outputTokens}，缓存命中 ${report.tokens.cacheHitRate === null ? '—' : (report.tokens.cacheHitRate * 100).toFixed(0) + '%'}`);
  console.log('');
  for (const c of report.perConversation) {
    const p50 = c.replyLatencyMs.p50 === null ? '—' : `${(c.replyLatencyMs.p50 / 1000).toFixed(0)}s`;
    const p90 = c.replyLatencyMs.p90 === null ? '—' : `${(c.replyLatencyMs.p90 / 1000).toFixed(0)}s`;
    console.log(`${c.key}: 入 ${c.incoming} / 出 ${c.outgoing} / 唤醒 ${c.wakes} / 未读 ${c.unread} ｜ 回复中位 ${p50}、p90 ${p90} ｜ 重复 ${c.duplicateSelf}`);
  }
  if (report.warnings.length) {
    console.log('\n⚠️ 状态告警：');
    for (const w of report.warnings) console.log(' -', w);
  }
}
