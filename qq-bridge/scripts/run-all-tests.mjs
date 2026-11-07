#!/usr/bin/env node
// run-all-tests.mjs · 测试的统一发现与执行器
//
// 为什么要有它（2026-10-28 架构审视 P1-3）：
//   测试原本散在 4 个位置、由 2 个互不覆盖的执行器跑，而且 package.json 里
//   硬编码了 21 个文件名——新增测试不会被任何门禁发现，覆盖率只降不升。
//
// 现在：按目录/文件名约定自动发现，逐个执行（默认串行，避免抢同一端口/状态目录）。
//
// 用法：
//   node scripts/run-all-tests.mjs                 # 全部（单元 + 历史脚本 + _src）
//   node scripts/run-all-tests.mjs --list          # 只打印会发现哪些
//   node scripts/run-all-tests.mjs --unit          # 只跑 test/（根目录 *.test.mjs 兜底扫描，应为空）
//   node scripts/run-all-tests.mjs --legacy        # 只跑 scripts/test-*.mjs 与 _src/test_*.mjs
//   node scripts/run-all-tests.mjs --draft         # 加上未接线的草案测试（src/core）
//   node scripts/run-all-tests.mjs --kit           # 加上 ai-companion-kit/tests
//   node scripts/run-all-tests.mjs --only=memory   # 只跑文件名含 memory 的
//
// 退出码：0 全过 / 1 有失败。报告写入 state/test-report-all.json（git 忽略）。
//
// 实现要点：子进程用 stdio:'inherit'。用管道捕获输出在受限环境里会
// spawn EPERM（命名管道被禁），而这里只需要退出码，输出直接流给终端。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const QQ_BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(QQ_BRIDGE_DIR, '..');
const STATE_DIR = path.join(QQ_BRIDGE_DIR, 'state');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const wantUnit = has('--unit');
const wantLegacy = has('--legacy');
const wantAll = !wantUnit && !wantLegacy;
const TIMEOUT_MS = Number((argv.find((a) => a.startsWith('--timeout=')) ?? '').slice('--timeout='.length)) || 180000;

const listFiles = (dir, filter) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && filter(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch { return []; }
};
const listFilesDeep = (dir, filter) => {
  try {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listFilesDeep(p, filter));
      else if (entry.isFile() && filter(entry.name)) out.push(p);
    }
    return out;
  } catch { return []; }
};

const groups = [];
const pushGroup = (name, files) => {
  if (files.length) groups.push({ name, files: files.sort() });
};

if (wantAll || wantUnit) {
  pushGroup('unit/test', listFiles(path.join(QQ_BRIDGE_DIR, 'test'), (n) => /\.test\.(mjs|js)$/.test(n)));
  // [ROOT-TESTS-MOVED] 2026-11-03 根目录历史测试已全部迁进 test/；这一行保留作兜底，
  // 根目录若再出现 test-*.test.mjs，这里仍会发现（npm test 的 glob 覆盖不到）。
  pushGroup('unit/root', listFiles(QQ_BRIDGE_DIR, (n) => /^test-.*\.test\.(mjs|js)$/.test(n)));
  if (has('--draft')) pushGroup('draft', listFilesDeep(path.join(QQ_BRIDGE_DIR, 'archive', 'drafts'), (n) => /\.test\.mjs$/.test(n)));
}
if (wantAll || wantLegacy) {
  pushGroup('legacy/scripts', listFiles(path.join(QQ_BRIDGE_DIR, 'scripts'), (n) => /^test-.*\.mjs$/.test(n)));
  pushGroup('legacy/_src', listFiles(path.join(REPO_ROOT, '_src'), (n) => /^test_.*\.mjs$/.test(n)));
}
if (has('--kit')) {
  const kitTests = path.join(REPO_ROOT, 'ai-companion-kit', 'tests');
  pushGroup('kit', listFiles(kitTests, (n) => /\.mjs$/.test(n)));
}

const filtered = only
  ? groups.map((g) => ({ ...g, files: g.files.filter((f) => path.basename(f).includes(only)) })).filter((g) => g.files.length)
  : groups;

if (!filtered.length) {
  console.error('没有发现任何测试文件（检查路径/过滤条件）。');
  process.exit(1);
}

const all = filtered.flatMap((g) => g.files);
if (has('--list')) {
  for (const g of filtered) {
    console.log(`\n## ${g.name}（${g.files.length}）`);
    for (const file of g.files) console.log(`  ${path.relative(REPO_ROOT, file)}`);
  }
  console.log(`\n合计 ${all.length} 个文件`);
  process.exit(0);
}

const runOne = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [file], {
    cwd: file.includes(`${path.sep}scripts${path.sep}`) ? QQ_BRIDGE_DIR : path.dirname(file),
    stdio: 'inherit',
    windowsHide: true,
  });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, TIMEOUT_MS);
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ file, code: code ?? 1, signal: signal ?? null, ms: Date.now() - started });
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ file, code: 1, error: String(error?.message ?? error), ms: Date.now() - started });
  });
});

console.log(`发现 ${all.length} 个测试文件（${filtered.map((g) => `${g.name}:${g.files.length}`).join('，')}）`);
const results = [];
for (const group of filtered) {
  console.log(`\n===== ${group.name}（${group.files.length}）=====`);
  for (const file of group.files) {
    const result = await runOne(file);
    results.push({ group: group.name, ...result });
    const mark = result.code === 0 ? 'PASS' : 'FAIL';
    const rel = path.relative(REPO_ROOT, result.file);
    console.log(`${mark} ${rel}（${result.ms}ms${result.signal ? `，signal=${result.signal}` : ''}）`);
  }
}

const failed = results.filter((r) => r.code !== 0);
const passed = results.length - failed.length;
console.log(`\n===== 汇总：${results.length} 个，通过 ${passed}，失败 ${failed.length} =====`);
for (const r of failed) console.log(`FAIL ${path.relative(REPO_ROOT, r.file)}（exit ${r.code}）`);

try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIR, 'test-report-all.json'),
    JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, failed: failed.map((r) => r.file), results }, null, 2),
    'utf8',
  );
} catch { /* 报告写不了不影响结论 */ }

process.exit(failed.length ? 1 : 0);
