// audit-timers.mjs · 旧系统定时器分类（绞杀者 P2 收编依据）。
//
// 干什么：扫 src/ 下所有 .js/.mjs 的 setInterval/setTimeout 调用点，按节奏分成两类：
//   A. 周期调度（候选收编进内核 tick 的阶段）：setInterval 且间隔 >= 60s
//   B. 高频基础设施（保留：心跳/重连/看门狗）：setInterval 间隔 < 60s
//   C. 一次性（保留：重试/防抖/超时）：setTimeout
// 为什么：旧系统 ~94 处定时器各自推进状态、各写各账本，是"时间被切碎"的病根；
//         整合时只有 A 类该进 tick，B/C 类保留。先分类才能知道要退役哪些、decide 要补什么。
// 用法：node scripts/audit-timers.mjs [--out <md>]

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const srcDir = resolve(root, 'src');
// [OBS-PATHS] 报告统一写仓库根 data/reports（与 app/对账脚本同一观测根），不再落 qq-bridge/data。
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]
  : resolve(obsPaths().reports, 'timer-audit.md');

const SKIP = /(^|[\\/])(kernel[\\/]|domain[\\/]leaves[\\/]|node_modules[\\/])/;
const PERIODIC_MS = 60000;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.test(p)) walk(p, out); }
    else if (/\.(js|mjs)$/.test(e.name) && !SKIP.test(p)) out.push(p);
  }
  return out;
}

const files = walk(srcDir);
const rows = [];
const intervalRe = /setInterval\(\s*[^,]*,\s*(\d+)/g;
const timeoutRe = /setTimeout\(\s*(?:\(?[^)]*\)?\s*,\s*)?(\d+)?/g;

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(root, f).replace(/\\/g, '/');
  const lines = text.split('\n');
  let m;
  while ((m = intervalRe.exec(text))) {
    const ms = Number(m[1]);
    rows.push({ file: rel, type: 'setInterval', ms, kind: ms >= PERIODIC_MS ? 'A-周期调度(候选收编)' : 'B-高频基础设施(保留)' });
  }
  while ((m = timeoutRe.exec(text))) {
    const ms = m[1] != null ? Number(m[1]) : null;
    const ln = lines.find((l) => l.includes('setTimeout')) || '';
    const tag = /retry|debounce|timeout|delay|throttle/i.test(ln) ? '重试/防抖' : '一次性';
    rows.push({ file: rel, type: 'setTimeout', ms, kind: `C-一次性(${tag},保留)` });
  }
}

const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
const byDir = {};
for (const r of rows) { const d = r.file.split('/')[1] || 'root'; byDir[d] = (byDir[d] || 0) + 1; }

const linesOut = [];
const L = (s = '') => { linesOut.push(s); console.log(s); };
L('# 旧系统定时器分类审计');
L();
L(`- 扫描目录：${srcDir}（已跳过 kernel/、domain/leaves/）`);
L(`- 调用点总数：${rows.length}`);
L();
L('## 按类别');
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) L(`- ${k}: ${v}`);
L();
L('## 按目录（domain）');
for (const [k, v] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) L(`- ${k}: ${v}`);
L();
L('## 明细（A 类=候选收编，优先看）');
for (const r of rows.filter((x) => x.kind.startsWith('A')).sort((a, b) => b.ms - a.ms)) {
  L(`- [${r.ms / 1000}s] ${r.file}`);
}
L();
L('## 明细（B/C 类=保留）');
for (const r of rows.filter((x) => !x.kind.startsWith('A'))) {
  L(`- ${r.type}${r.ms != null ? `(${r.ms}ms)` : ''} ${r.file} :: ${r.kind}`);
}

try { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, linesOut.join('\n'), 'utf8'); L(`\n✅ 报告已写：${outPath}`); } catch {}
