#!/usr/bin/env node
// module-matrix.mjs · 模块闭环矩阵：每个 src 模块「有没有人用 / 有没有测 / 有没有登记」
//
// 用途：给「所有模块不管大小功能是否闭环」提供可重复的证据，而不是靠记忆。
// 三个信号都来自源码事实：
//   接上（wired）  = 被 src 里别的文件 import（入口文件除外）
//   测到（tested） = 被 test/ 下某个测试文件直接 import
//   登记（mapped） = 出现在 docs/internal/模块地图.md 的表格里
//
// 用法：
//   node scripts/module-matrix.mjs            # 摘要 + 缺口清单
//   node scripts/module-matrix.mjs --all      # 打印全部模块
//   node scripts/module-matrix.mjs --json     # 机器可读
//   node scripts/module-matrix.mjs --write    # 写 docs/internal/模块闭环矩阵-YYYYMMDD.md
// 退出码：0（这是体检报告，不是门禁；门禁见 audit:wiring / audit:architecture）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test');
const DOCS = path.join(ROOT, '..', 'docs', 'internal');

// 这些不是"没人 import"，是独立入口：进程/线程入口、`--import` 预加载、外部共享内核。
const ENTRY_FILES = new Set([
  'src/bridge.js',            // 桥接入口
  'src/app.mjs',              // main()
  'src/config-check.mjs',     // 独立体检
  'src/self-test.js',         // npm run self-test
  'src/quant/cli.mjs',        // 量化 CLI
  'src/crash-forensics.js',   // watchdog 用 --import 预加载
  'src/domain/leaves/inori-workshop-worker.js', // Worker 线程入口（new Worker(new URL(...))）
  'src/mcp-host-server.js',   // MCP 进程入口（setup-dsh 注册）
  'src/mcp-snowluma-safe.js', // 同上
  'src/mcp-web-search-safe.js', // 同上
  'src/voice-core.js',        // 共享内核：voice-tool/ 与脚本直接按路径引用
]);
const rel = (f) => path.relative(ROOT, f).replaceAll('\\', '/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(entry.name) && !entry.name.includes('.bak')) out.push(full);
  }
  return out;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  // [QUERY-STRIP] 单测常用 `import('../src/x.js?t=...')` 拿新实例（绕开模块级缓存/冷却），
  // 带查询串或哈希时也要解析到真实文件，否则这些模块会被误报成「无直接测试」。
  const clean = String(spec).split('?')[0].split('#')[0];
  const base = path.resolve(path.dirname(fromFile), clean);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 不存在就试下一个 */ }
  }
  return null;
}

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = [];
  for (const m of src.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  // 模板字面量形式：import(`../src/x.js?t=${...}`) —— 取 `${` 前的静态前缀即可定位模块
  for (const m of src.matchAll(/\bimport\s*\(\s*`([^`]*)`/g)) specs.push(String(m[1]).split('${')[0]);
  return specs;
}

export function buildMatrix() {
  const sources = walk(SRC);
  // [ROOT-TESTS-MOVED] 2026-11-03 根目录 18 个历史 test-*.test.mjs 已全部迁进 test/
  // （同名且内容不同的加 -legacy 后缀，两份都跑），这里只扫 test/ 即可。
  // 根目录若再冒出新测试，test:core 的 glob 不会覆盖到，由 run-all-tests 的 unit/root 兜底发现。
  const tests = walk(TEST);
  const importers = new Map(sources.map((f) => [f, new Set()]));
  const testers = new Map(sources.map((f) => [f, new Set()]));

  const brokenImports = new Map(sources.map((f) => [f, []]));
  for (const file of sources) {
    for (const spec of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target && importers.has(target)) importers.get(target).add(rel(file));
      // [BROKEN-IMPORT] 此前 resolveImport 对不存在的相对路径返回 null 后被静默忽略，
      // 删/改名一个模块后只要没有测试顺着链路触达它，CI 全绿。这里把「指向不存在文件的相对 import」记下来。
      else if (spec.startsWith('.') && !target) brokenImports.get(file).push(spec);
    }
  }
  for (const file of tests) {
    for (const spec of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target && testers.has(target)) testers.get(target).add(rel(file));
    }
  }

  // [DOCS-CONSOLIDATED] 2026-11-05：模块地图合并为固定文件名；旧 dated 文件仅作兼容回退。
  const mapDoc = fs.existsSync(DOCS)
    ? (fs.existsSync(path.join(DOCS, '模块地图.md'))
      ? '模块地图.md'
      : fs.readdirSync(DOCS).filter((f) => f.startsWith('模块地图-')).sort().pop())
    : null;
  const mapText = mapDoc ? fs.readFileSync(path.join(DOCS, mapDoc), 'utf8') : '';
  // [MAP-OPTIONAL] .gitignore 已为 docs/internal/模块地图.md 开例外（2026-11-07），
  // 该文件提交后 CI checkout 就能拿到地图，「登记」信号才真正生效。
  // 地图仍缺失时（未提交/旧检出）跳过「登记」（null），只查接线与直接测试，
  // 否则 CI 上所有模块都会被误报成「未登记」。
  const mapMissing = !mapDoc;

  const rows = sources.map((file) => {
    const r = rel(file);
    const base = path.basename(file);
    return {
      file: r,
      base,
      lines: fs.readFileSync(file, 'utf8').split('\n').length,
      domain: domainOf(r),
      importers: [...importers.get(file)].sort(),
      tests: [...testers.get(file)].sort(),
      mapped: mapMissing ? null : (mapText.includes(base) || mapText.includes(r)),
      entry: ENTRY_FILES.has(r),
      broken: brokenImports.get(file) ?? [],
    };
  });
  return { mapDoc, mapMissing, rows };
}

function domainOf(relPath) {
  if (relPath.includes('/onebot/')) return '接入/OneBot';
  if (relPath.includes('/bootstrap/')) return '引导';
  if (relPath.includes('/quant/')) return '量化';
  if (/\/inori-[^/]+\.js$/.test(relPath)) return '叶子能力(inori-*)';
  if (/-service\.mjs$|-runtime\.mjs$/.test(relPath)) return '服务/编排';
  if (/^src\/(mcp-|console-|dsh-|snowluma-)/.test(relPath)) return '设备面/协议';
  return '其他';
}

function gapsOf(row) {
  const gaps = [];
  if (!row.entry && row.importers.length === 0) gaps.push('没人 import');
  // [ENTRY-EXEMPT] 进程/线程/MCP 入口不按"单测覆盖"要求：它们是靠 smoke-bridge / setup 注册
  // 与运行期日志验证的，写单测只会测到桩。入口文件仍然要求登记进模块地图。
  if (!row.entry && row.tests.length === 0) gaps.push('无直接测试');
  if (row.mapped === false) gaps.push('模块地图未登记');
  if (row.broken && row.broken.length) gaps.push('断链 import: ' + row.broken.join(', '));
  return gaps;
}

function summary(rows) {
  const total = rows.length;
  const wired = rows.filter((r) => r.entry || r.importers.length).length;
  const tested = rows.filter((r) => r.tests.length).length;
  const mapped = rows.filter((r) => r.mapped).length;
  const byDomain = new Map();
  for (const r of rows) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, { total: 0, tested: 0, wired: 0, mapped: 0, gaps: 0 });
    const d = byDomain.get(r.domain);
    d.total += 1;
    if (r.tests.length) d.tested += 1;
    if (r.entry || r.importers.length) d.wired += 1;
    if (r.mapped) d.mapped += 1;
    if (gapsOf(r).length) d.gaps += 1;
  }
  return { total, wired, tested, mapped, byDomain };
}

function localDate(sep = '-') {
  // 用本地日期而不是 toISOString()：东八区的 00:35 在 UTC 还是前一天，文件名会错一天。
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join(sep);
}

function renderMarkdown({ mapDoc, mapMissing, rows }) {
  const s = summary(rows);
  const lines = [];
  lines.push(`# 模块闭环矩阵（${localDate()}）`);
  lines.push('');
  lines.push('> 由 `node scripts/module-matrix.mjs --write` 生成，别手改。');
  lines.push('> 三个信号：**接上**（被 src 里别的文件 import）、**测到**（被 test/ 直接 import）、**登记**（出现在模块地图）。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 源码模块：**${s.total}** 个`);
  lines.push(`- 接上：**${s.wired}/${s.total}**（没人 import 的见下）`);
  lines.push(`- 测到：**${s.tested}/${s.total}**（无直接测试）`);
  lines.push(`- 登记：**${mapMissing ? '跳过（模块地图未提供）' : `${s.mapped}/${s.total}`}**（模块地图：${mapDoc ?? '缺失'}）`);
  lines.push('');
  lines.push('| 域 | 模块 | 接上 | 测到 | 登记 | 有缺口 |');
  lines.push('|---|---|---|---|---|---|');
  for (const [domain, d] of [...s.byDomain].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${domain} | ${d.total} | ${d.wired} | ${d.tested} | ${d.mapped} | ${d.gaps} |`);
  }
  lines.push('');
  lines.push('## 缺口清单');
  lines.push('');
  for (const domain of [...s.byDomain.keys()]) {
    const group = rows.filter((r) => r.domain === domain && gapsOf(r).length);
    if (!group.length) continue;
    lines.push(`### ${domain}`);
    lines.push('');
    lines.push('| 模块 | 行数 | 缺口 |');
    lines.push('|---|---|---|');
    for (const r of group.sort((a, b) => b.lines - a.lines)) {
      lines.push(`| \`${r.file}\` | ${r.lines} | ${gapsOf(r).join('、')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const matrix = buildMatrix();
  if (args.has('--json')) {
    console.log(JSON.stringify(matrix.rows.map((r) => ({ ...r, gaps: gapsOf(r) })), null, 2));
  } else if (args.has('--write')) {
    const date = localDate('');
    const out = path.join(DOCS, `模块闭环矩阵-${date}.md`);
    fs.mkdirSync(DOCS, { recursive: true });
    fs.writeFileSync(out, renderMarkdown(matrix), 'utf8');
    console.log(`已写入：${out}`);
  } else {
    const s = summary(matrix.rows);
    const mapNote = matrix.mapMissing ? ' / 登记 跳过（模块地图未提供）' : ` / 登记 ${s.mapped}`;
    console.log(`模块闭环矩阵：${s.total} 个模块 / 接上 ${s.wired} / 测到 ${s.tested}${mapNote}`);
    if (matrix.mapMissing) console.log('⚠️ docs/internal 不可用：本轮跳过「登记」信号，只查接线与直接测试');
    const gaps = matrix.rows.filter((r) => gapsOf(r).length);
    console.log(`有缺口：${gaps.length}`);
    const show = args.has('--all') ? matrix.rows : gaps;
    for (const r of show.sort((a, b) => a.domain.localeCompare(b.domain) || b.lines - a.lines)) {
      const g = gapsOf(r);
      console.log(`${g.length ? '⚠️ ' : '✅ '}${r.file}  [${r.domain}] ${g.length ? g.join('、') : '闭环齐全'}`);
    }
    // [MAP-SKIP-WARN] 地图缺失时「登记」信号会被跳过，必须显式告警，
    // 避免误以为矩阵在 CI 抓到了未登记模块（实际只查接线/直接测试）。
    // 用 mapMissing 而非「目录是否存在」：目录存在但地图文件没提交，同样要告警。
    if (matrix.mapMissing) {
      console.error('⚠️ 模块地图缺失（docs/internal/模块地图.md 未检出）：本轮「登记」信号被跳过，只查接线与直接测试。请确认 .gitignore 的例外已生效，并把地图提交进版本库。');
    }
    // [STRICT] 登记/接线/直接测试都齐了之后，矩阵才能当门禁用；默认仍是体检报告。
    if (args.has('--strict') && gaps.length) {
      console.error(`\n模块矩阵未闭合：${gaps.length} 个模块有缺口（用 --strict 时退出码 1）`);
      process.exitCode = 1;
    }
  }
}
