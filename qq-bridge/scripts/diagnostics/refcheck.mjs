// 只读源码诊断：动态收集 src 导出的符号，并统计其在 src + test 中的外部引用次数。
//
// 取代旧版（2026-10-27）：旧版只扫描 bridge.js 且用硬编名称清单，会漏掉别名引用、
// 并报出根本不存在于代码中的幻影名（如 stopOwnLife）。本版改为：
//   1) 从 src/**/*.{mjs,js} 实际收集 export 出的符号（含 export { a, b } 形式）；
//   2) 在 src + test 全量统计 \bNAME\b 出现次数，扣除定义处本身；
//   3) 不出现的符号不计入（幻影名自然被排除）；别名/跨文件引用都能被数到。
//
// 用法：node scripts/diagnostics/refcheck.mjs [名称...]
//   - 省略参数：扫描全部导出符号，末尾列出 0 处外部引用的（可能为未使用的导出 API，需人工确认是否故意保留）。
//   - 给定名称：只报告这些名字的外部引用数（非导出符号会标注「幻影，跳过」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test');
const SRC_EXT = new Set(['.mjs', '.js']);

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (SRC_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_FROM_RE = /export\s*\{([^}]+)\}/g;

function collectExports(files) {
  const names = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = EXPORT_RE.exec(src))) names.add(m[1]);
    while ((m = EXPORT_FROM_RE.exec(src))) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      }
    }
  }
  return [...names];
}

function countRefs(name, files) {
  const re = new RegExp('\\b' + name + '\\b', 'g');
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const matches = src.match(re);
    if (matches) total += matches.length;
  }
  return total; // 含定义处自身，调用方自行 -1
}

const srcFiles = walk(SRC);
const testFiles = walk(TEST);
const allFiles = [...srcFiles, ...testFiles];
const exported = collectExports(srcFiles);

const requested = process.argv.slice(2);
const names = requested.length ? requested : exported;

const rows = [];
for (const n of names) {
  if (!exported.includes(n)) {
    console.log(`${n}: 非导出符号（幻影，跳过）`);
    continue;
  }
  const external = countRefs(n, allFiles) - 1; // 扣除定义处
  rows.push({ n, external });
  console.log(`${n}: ${external} 处外部引用`);
}

if (!requested.length) {
  const dead = rows.filter((r) => r.external <= 0).map((r) => r.n);
  console.log('\n— 0 处外部引用的导出符号（可能为未使用的 API，需人工确认是否故意保留）—');
  console.log(dead.length ? dead.join('\n') : '（无）');
}
