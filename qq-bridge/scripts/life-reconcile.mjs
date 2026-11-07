#!/usr/bin/env node
// life-reconcile.mjs · 宪章 S4：内核影子态 ↔ state-hub 的逐字段对账（只读脚本）
//
// 用法：
//   node scripts/life-reconcile.mjs            # 人读表
//   node scripts/life-reconcile.mjs --json     # 机器读（含源文件是否存在）
//   node scripts/life-reconcile.mjs --check    # 有超容忍偏差或 no-data 时 exit 1（门禁用）
//   node scripts/life-reconcile.mjs --scale=2  # 容忍带整体放大 2 倍（观察期临时用）
//
// 不做什么：不写任何状态、不启动内核、不改配置；只读 data/state/mind 两个 JSON。
import fs from 'node:fs';
import { obsPaths } from './lib/observability-paths.mjs';
import { compareLifeStates, formatReconcileReport } from '../src/domain/mind/life-reconcile.mjs';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const scaleArg = args.find((a) => a.startsWith('--scale='));
const parsedScale = scaleArg ? Number(scaleArg.slice('--scale='.length)) : 1;
const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;

const paths = obsPaths();
const kernel = readJson(paths.kernelState);
const hub = readJson(paths.stateHub);
const report = compareLifeStates(kernel, hub, { scale });
const body = {
  ...report,
  source: {
    kernel: paths.kernelState,
    hub: paths.stateHub,
    kernelExists: Boolean(kernel),
    hubExists: Boolean(hub),
  },
};

if (has('--json')) {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
} else {
  process.stdout.write(formatReconcileReport(body) + '\n');
  if (!kernel || !hub) process.stdout.write('提示：先设 life.mode=shadow 并让生命循环跑至少一拍，再对账。\n');
}

if (has('--check') && !body.ok) process.exit(1);
