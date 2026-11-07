// kernel-shadow-reconcile.mjs · 影子对账偏差报告（绞杀者 P1→P2 的门槛证明）。
//
// 干什么：读 data/reports/kernel-shadow.jsonl（app.mjs 在 life.mode=shadow 时逐拍写的 trace），
//         汇总内核跑出的决策分布 / 状态轨迹 / 失败情况；可选 --old-state <file> 把内核末拍标量
//         与旧系统真实状态逐字段 diff，量化"新旧差多少"。
// 为什么：P2 切心跳前必须先证明"内核读到的起点 == 旧系统此刻的状态"，否则接上后会凭空跳变。
// 影子来源（2026-11-05 校正）：app.mjs 用 createQQPorts + seedFromOldSystem 起步，
//         state 落 data/state/mind/kernel-state.json，事件/act 仍是内存桩；
//         trace 默认写 <repo>/data/reports/kernel-shadow.jsonl（与读取端同一路径）。
// 用法：node scripts/kernel-shadow-reconcile.mjs [--shadow <path>] [--old-state <file>] [--out <md>]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const REPORTS = obsPaths().reports;
const shadowPath = arg('--shadow', resolve(REPORTS, 'kernel-shadow.jsonl'));
const oldStatePath = arg('--old-state', null);
const outPath = arg('--out', resolve(REPORTS, 'kernel-shadow-reconcile.md'));

function loadTicks(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function histogram(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = x?.[key]; if (k == null) continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function stats(nums) {
  if (!nums.length) return { min: null, max: null, first: null, last: null };
  const n = nums.filter((x) => Number.isFinite(x));
  return { min: Math.min(...n), max: Math.max(...n), first: n[0], last: n[n.length - 1] };
}

const ticks = loadTicks(shadowPath);
const lines = [];
const ln = (s = '') => { lines.push(s); console.log(s); };

if (!ticks) {
  ln(`⚠️ 未找到影子 trace：${shadowPath}`);
  ln('   开启方式：在 config.json 设 "life": { "mode": "shadow" }，重启桥接，跑满一段后重跑本脚本。');
  ln('   本脚本仍可带 --old-state 单独比对旧系统状态，但无 trace 时只做静态对照。');
  process.exit(0);
}

const ats = ticks.map((t) => Number(t.at)).filter(Number.isFinite);
const spanMs = ats.length > 1 ? Math.max(...ats) - Math.min(...ats) : 0;
const intentHist = histogram(ticks, 'intention');
const sourceHist = histogram(ticks, 'source');
const energy = stats(ticks.map((t) => t.energy));
const hunger = stats(ticks.map((t) => t.hunger));
const failed = ticks.filter((t) => t.failed);
const lessonsLast = ticks.length ? ticks[ticks.length - 1].lessons : 0;
const refsLast = ticks.length ? ticks[ticks.length - 1].refs : 0;

ln('# 影子内核对账偏差报告');
ln();
ln(`- trace 文件：${shadowPath}`);
ln(`- 拍数：${ticks.length}`);
ln(`- 时间跨度：${(spanMs / 3600000).toFixed(2)} h（${new Date(Math.min(...ats)).toISOString()} → ${new Date(Math.max(...ats)).toISOString()}）`);
ln();
ln('## 决策分布（intention）');
for (const [k, v] of intentHist) ln(`- ${k}: ${v} (${(v / ticks.length * 100).toFixed(1)}%)`);
ln();
ln('## 决策来源（source）');
for (const [k, v] of sourceHist) ln(`- ${k || '(未标注)'}: ${v}`);
ln();
ln('## 状态轨迹（内核内部标量）');
ln(`- energy：首 ${fmt(energy.first)} / 最小 ${fmt(energy.min)} / 最大 ${fmt(energy.max)} / 末 ${fmt(energy.last)}`);
ln(`- socialHunger(hunger)：首 ${fmt(hunger.first)} / 最小 ${fmt(hunger.min)} / 最大 ${fmt(hunger.max)} / 末 ${fmt(hunger.last)}`);
ln(`- lessons 末值：${lessonsLast}；lessonRefs 末值：${refsLast}`);
ln();
ln('## 失败（failed 非空）');
ln(`- 计数：${failed.length}`);
for (const f of failed.slice(0, 10)) ln(`- at=${f.at} phase=${f.failed?.phase} error=${f.failed?.error}`);
ln();

function fmt(x) { return x == null ? '—' : Number(x).toFixed(3); }

// 与旧系统真实状态逐字段 diff
if (oldStatePath && existsSync(oldStatePath)) {
  let oldState;
  try { oldState = JSON.parse(readFileSync(oldStatePath, 'utf8')); } catch (e) { ln(`⚠️ 旧状态解析失败：${e.message}`); oldState = null; }
  if (oldState) {
    const last = ticks[ticks.length - 1];
    const kernelScalars = { energy: last.energy, socialHunger: last.hunger };
    const overlap = Object.keys(kernelScalars).filter((k) => Number.isFinite(Number(oldState[k])));
    ln('## 与旧系统状态偏差（--old-state）');
    if (!overlap.length) {
      ln(`- 旧状态文件 ${oldStatePath} 无与内核标量同名的数值字段（energy/socialHunger）。`);
      ln('  旧系统状态分散在 self-state/beliefs/curiosity/own-life 等多文件，需先做字段映射。');
    } else {
      for (const k of overlap) {
        const ko = Number(kernelScalars[k]);
        const oo = Number(oldState[k]);
        const d = (ko - oo).toFixed(3);
        ln(`- ${k}：内核 ${fmt(ko)} / 旧系统 ${fmt(oo)} / Δ ${d}`);
      }
    }
    ln();
  }
} else if (oldStatePath) {
  ln(`⚠️ --old-state 指定文件不存在：${oldStatePath}`);
  ln();
}

ln('## 结论');
if (ticks.length < 2) {
  ln('- trace 不足：先让影子跑满至少一段（建议 24h）再对账。');
} else {
  ln('- 内核自身轨迹已可读；决策分布见上。');
  ln('- 注意：当前影子以**合成初始状态**运行，并未读真实旧状态。要使偏差有意义，');
  ln('  需把影子切到 createQQPorts（load 读真实状态、仍不写旧状态），或先 --old-state 提供映射后的旧快照。');
}

try { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, lines.join('\n'), 'utf8'); ln(`\n✅ 报告已写：${outPath}`); } catch {}
