#!/usr/bin/env node
// state-overview.mjs · 生成跨域只读总览（任务 / 关系 / 媒体 / 学习引用）
//
// 用法：
//   node scripts/state-overview.mjs              # 写 data/state/overview.{json,md} 并打印摘要
//   node scripts/state-overview.mjs --json       # 只打印 JSON（仍写文件）
//   node scripts/state-overview.mjs --dry-run    # 只读，不写文件
//
// 本脚本不重启、不连网、不改任何源账本；只读已有状态文件。
import { collectOverview, renderOverviewText, writeOverview, DEFAULTS } from '../src/domain/leaves/inori-overview.js';
import { STATE_DATA_DIR } from '../src/domain/shared/project-paths.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const jsonOnly = args.has('--json');

const model = collectOverview();
if (jsonOnly) {
  process.stdout.write(JSON.stringify(model, null, 2) + '\n');
} else {
  console.log(renderOverviewText(model, { maxChars: DEFAULTS.maxTextChars }));
}

if (!dryRun) {
  const out = writeOverview(model);
  if (!jsonOnly) {
    console.log(`\n[state-overview] 已写入：${out.jsonFile}`);
    console.log(`[state-overview] 人读版：${out.mdFile}`);
  }
} else if (!jsonOnly) {
  console.log(`\n[dry-run] 未写文件；目标目录：${STATE_DATA_DIR}`);
}
