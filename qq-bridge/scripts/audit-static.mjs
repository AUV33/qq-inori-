// audit-static.mjs · 项目静态健康检查（只读、可重复跑；不替代 test:audit）
// 目的：把"重复代码 / 空 catch / 默认表漂移 / 工具面覆盖"变成可测量数字，优化前后能对比。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = `${PROJECT_ROOT}/qq-bridge`;
const SRC = path.join(ROOT, 'src');
const files = [];
const walkSrc = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(p);
    else if (/\.(js|mjs)$/.test(entry.name) && !entry.name.includes('.bak')) files.push(path.relative(SRC, p).split(path.sep).join('/'));
  }
};
walkSrc(SRC);
const lineCount = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/).length;

const report = {};
report.模块数 = files.length;
const sizes = files.map((f) => ({ f, lines: lineCount(f) })).sort((a, b) => b.lines - a.lines);
report.最大模块 = sizes.slice(0, 5);
report.总行数 = sizes.reduce((a, b) => a + b.lines, 0);

// 重复 10 行块（滑动窗口哈希，跨文件）
const W = 10;
const seen = new Map();
let dup = 0;
const dupFiles = [];
for (const f of files) {
  const L = fs.readFileSync(path.join(SRC, f), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i + W <= L.length; i++) {
    const win = L.slice(i, i + W);
    if (win.filter(Boolean).length < W) continue; // 跳过空白多的窗口
    const h = crypto.createHash('sha1').update(win.join('\n')).digest('hex');
    if (seen.has(h) && seen.get(h) !== f) {
      dup += 1;
      if (dupFiles.length < 8) dupFiles.push(`${seen.get(h)} + ${f}`);
    } else if (!seen.has(h)) {
      seen.set(h, f);
    }
  }
}
report.跨文件重复块 = dup;
report.重复出处样例 = dupFiles;

// 空 catch：区分「有理由的预期忽略」与「真正静默吞错」，并给可定位明细。
// 带注释说明原因的空 catch 是设计（best-effort），但要能一眼查到在哪；
// 完全无注释的空 catch 才是技术债，单列出来。
const emptyCatchDetail = { withReason: [], silent: [] };
for (const f of files) {
  const t = fs.readFileSync(path.join(SRC, f), 'utf8');
  for (const m of t.matchAll(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/g)) {
    const line = t.slice(0, m.index).split('\n').length;
    const row = `${f}:${line}`;
    if (m[2] && m[2].trim()) emptyCatchDetail.withReason.push(row);
    else emptyCatchDetail.silent.push(row);
  }
}
report.空catch = emptyCatchDetail.withReason.length + emptyCatchDetail.silent.length;
report.空catch_有理由 = emptyCatchDetail.withReason.length;
report.空catch_纯静默 = emptyCatchDetail.silent.length;
report.空catch_纯静默明细 = emptyCatchDetail.silent.slice(0, 20);

// [SCAN-ALL] 旧实现只在 src/bridge.js 里数这三个指标，而 bridge.js 2026-10-28 已拆成
// 17 行入口壳（main 在 app.mjs）——于是永远报 0，看起来像"健康"，实际是"没测"。
// 改为扫全 src；指标含义不变，只是量在真正有代码的地方。
const allSrc = files.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
report.tools默认表 = (allSrc.match(/SOCIAL_V2_TOOLS_DEFAULTS\s*=\s*\{/g) || []).length;
report.OneBot错误模板 = (allSrc.match(/OneBot \$\{action\} 失败/g) || []).length;
report.SaveState调用 = (allSrc.match(/\bsaveState\(\)/g) || []).length;

// 工具面覆盖（如果 _tmp/tool-list.json 存在）
try {
  const names = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/_tmp/tool-list.json`, 'utf8'));
  const strip = (n) => String(n).replace(/^mcp__[a-z-]+__/, '');
  const actual = new Set(names.map(strip));
  report.真实工具数 = actual.size;
} catch { report.真实工具数 = null; }

report.测试脚本数 = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f)).length;

console.log(JSON.stringify(report, null, 1));
