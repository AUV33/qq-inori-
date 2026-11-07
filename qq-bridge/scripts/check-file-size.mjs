// check-file-size.mjs · 巨型文件门禁（Phase 1-E 的一部分）
//
// 背景：audit-static 已把"最大模块"列为 Top5，但只是报告。console-server.mjs(≈365KB) 与
// app.mjs(≈267KB) 是已知 god-file。本脚本把"门禁"落到实处：任何 src 下源码超过
// MAX_LINES 行即失败——但先把这两个已知巨无霸放进 ALLOWLIST，所以今天能过，
// 未来新增的超大文件会被立即拦下。等它们被拆分后，再把对应项从 ALLOWLIST 移除。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_LINES = 1500;
const SRC_DIRS = ['src', 'scripts'];
const EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'archive',
  'test', 'tests', 'fixtures', 'generated', '.github', 'docs',
]);
// 已知巨无霸：拆分完成前豁免，拆分后删除对应项使门禁真正生效。
// 注：mcp-reserved2-tools.js 是 2026-11 从 mcp-snowluma-safe.js 抽出的二代仿真组（1560 行），
// 本身仍是 god-file，按纪律暂列豁免，待下一轮拆分（核心发送组 / 表情组）再移出。
const ALLOWLIST = new Set([
  'src/adapters/console-server.mjs',
  'src/app.mjs',
  'src/mcp-reserved2-tools.js',
]);

const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE.has(e.name)) continue;
      walk(full, out);
    } else if (EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

const files = [];
for (const d of SRC_DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) walk(abs, files);
}

let failed = 0;
const offenders = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (ALLOWLIST.has(rel)) continue;
  let n = 0;
  try {
    const buf = fs.readFileSync(f);
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    if (buf.length && buf[buf.length - 1] !== 0x0a) n++;
  } catch { continue; }
  if (n > MAX_LINES) {
    failed++;
    offenders.push(`${rel} (${n} 行 > ${MAX_LINES})`);
  }
}

if (offenders.length) {
  console.error(`[check-file-size] ❌ 发现 ${offenders.length} 个超过 ${MAX_LINES} 行的源文件（ALLOWLIST 豁免项除外）：`);
  for (const o of offenders) console.error(`   - ${o}`);
  console.error('[check-file-size] 请拆分后再提交；已存在的巨无霸见 ALLOWLIST（拆分后移除对应项）。');
  process.exitCode = 1;
} else {
  console.log(`[check-file-size] ✅ 无新增超大文件（上限 ${MAX_LINES} 行；已知巨无霸在 ALLOWLIST 中）。`);
}
