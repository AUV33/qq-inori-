// tool-usage-stats.mjs · 她的工具使用画像：调用次数 / 成败 / 从未用过
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const rows = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/state/tool-calls.jsonl`, 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const calls = rows.filter((r) => r.type === 'call');
const results = rows.filter((r) => r.type === 'result');
const strip = (n) => String(n || '').replace(/^mcp__[a-z-]+__/, '');
const byTool = new Map();
for (const r of calls) {
  const t = strip(r.tool);
  if (!byTool.has(t)) byTool.set(t, { calls: 0, ok: 0, fail: 0 });
  byTool.get(t).calls += 1;
}
for (const r of results) {
  const t = strip(r.tool);
  if (!byTool.has(t)) byTool.set(t, { calls: 0, ok: 0, fail: 0 });
  if (r.ok === true) byTool.get(t).ok += 1; else if (r.ok === false) byTool.get(t).fail += 1;
}
const used = [...byTool.entries()].filter(([, v]) => v.calls > 0 || v.ok > 0 || v.fail > 0);
used.sort((a, b) => b[1].calls - a[1].calls);
console.log('=== 用过的工具（按调用数）===');
for (const [t, v] of used) console.log(`${String(v.calls).padStart(3)} 次  ok ${String(v.ok).padStart(3)} / fail ${String(v.fail).padStart(2)}  ${t}`);

// 与真实工具面对比
let names = [];
try { names = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/_tmp/tool-list.json`, 'utf8')); } catch { /* 没有清单 */ }
const actual = new Set(names.map(strip));
const usedNames = new Set(used.map(([t]) => t));
const never = [...actual].filter((n) => !usedNames.has(n));
console.log(`\n=== 从未调用过：${never.length}/${actual.size} ===`);
console.log(never.join(', '));
console.log(`\n总调用 ${calls.length} 次，成功 ${results.filter((r) => r.ok === true).length}，失败 ${results.filter((r) => r.ok === false).length}`);
