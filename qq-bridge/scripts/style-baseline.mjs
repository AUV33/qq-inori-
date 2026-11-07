#!/usr/bin/env node
// style-baseline.mjs · 宪章 A1/G10：从她自己的 utterance 建文风基线，比较漂移，算 5% 步长
//
// 用法：
//   node scripts/style-baseline.mjs [--days=90] [--json]       # 看当前指纹/基线状态
//   node scripts/style-baseline.mjs --save [--apply]           # 写基线（默认 dry-run）
//   node scripts/style-baseline.mjs --compare [--json]         # 当前 vs 基线漂移
//   node scripts/style-baseline.mjs --plan [--json]            # 下一步步长（≤5%）
//   --file=<path> 覆盖基线文件；--apply 才写盘（写前备份 .bak-style-<ts>）。
import fs from 'node:fs';
import path from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';
import { collectUtterances, buildStyleBaseline, planStyleStep, MIN_SAMPLES } from './lib/style-baseline.mjs';
import { styleFingerprint, styleDrift } from './lib/living-eval.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (prefix, fallback = '') => { const row = args.find((a) => a.startsWith(prefix)); return row ? row.slice(prefix.length) : fallback; };
const json = has('--json');
const paths = obsPaths();
const file = path.resolve(valueOf('--file=', paths.styleBaseline));
const days = Number(valueOf('--days=', '90')) || 90;

function readMemoryRows(dir) {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^memory.*\.jsonl$/.test(n)); } catch { return rows; }
  for (const name of names) {
    try {
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
      }
    } catch { /* 单文件失败不挡整轮 */ }
  }
  return rows;
}
function readBaseline() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeBaseline(baseline) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-style-${Date.now()}`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

try {
  const rows = readMemoryRows(paths.memory);
  const texts = collectUtterances(rows, { now: Date.now(), days });
  const current = buildStyleBaseline(texts, { now: Date.now() });
  const existing = readBaseline();

  if (has('--save')) {
    if (current.insufficient) {
      const body = { ok: false, reason: `样本不足（${current.samples} < ${MIN_SAMPLES}）`, samples: current.samples };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] 样本不足：${current.samples} < ${MIN_SAMPLES}`);
      process.exitCode = 1;
    } else if (!has('--apply')) {
      const body = { ok: true, applied: false, file, samples: current.samples, metrics: current.metrics };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] dry-run：${current.samples} 条样本，加 --apply 才写 ${file}`);
    } else {
      writeBaseline(current);
      const body = { ok: true, applied: true, file, samples: current.samples, metrics: current.metrics };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] 已写基线：${current.samples} 条 → ${file}`);
    }
  } else if (has('--compare')) {
    if (current.samples < MIN_SAMPLES) {
      const body = { ok: false, reason: `当前样本不足（${current.samples} < ${MIN_SAMPLES}），不能比较漂移`, samples: current.samples };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] ${body.reason}`);
      process.exitCode = 1;
    } else if (!existing?.metrics) {
      const body = { ok: false, reason: '没有基线，先 --save --apply' };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] ${body.reason}`);
      process.exitCode = 1;
    } else {
      const drift = styleDrift(existing.metrics, current.metrics);
      const body = { ok: true, baselineAt: existing.at, baselineSamples: existing.samples, currentSamples: current.samples, drift };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] 漂移=${drift.drift ? '是' : '否'}（worst ${Math.round(drift.worst * 100)}%，阈值 ${Math.round(drift.maxDelta * 100)}%）`);
    }
  } else if (has('--plan')) {
    if (current.samples < MIN_SAMPLES) {
      const body = { ok: false, reason: `当前样本不足（${current.samples} < ${MIN_SAMPLES}），不能规划步长`, samples: current.samples };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] ${body.reason}`);
      process.exitCode = 1;
    } else if (!existing?.metrics) {
      const body = { ok: false, reason: '没有基线，先 --save --apply' };
      if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n'); else console.log(`[style] ${body.reason}`);
      process.exitCode = 1;
    } else {
      const plan = planStyleStep(existing, current, { maxStep: Number(valueOf('--max-step=', '0.05')) || 0.05 });
      if (json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      else console.log(`[style] 下一步（步长≤${Math.round(plan.maxStep * 100)}%）：${Object.entries(plan.steps).map(([k, v]) => `${k} ${v.from}→${v.to}`).join('；')}`);
    }
  } else {
    const body = { ok: true, file, samples: current.samples, metrics: current.metrics, baseline: existing ? { at: existing.at, samples: existing.samples } : null };
    if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    else console.log(`[style] 当前样本 ${current.samples}；基线${existing ? '已有' : '无'}（${file}）`);
  }
} catch (error) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2) + '\n');
  else console.error(`[style] 失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
