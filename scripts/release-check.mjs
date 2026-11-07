#!/usr/bin/env node
// scripts/release-check.mjs · 开源发布前检查（**只读**，绝不执行 git 写操作）
//
// PUBLISHING.md 第二节原来是一串手工 git grep，很容易漏；这里把能自动判定的部分收成一个
// 命令。脚本不会 --orphan、不会 push、不会改 index、不会轮换令牌——这些必须人工执行，
// 并会在结尾原样列出。
//
// 用法：
//   node scripts/release-check.mjs        # 本地发布前（要求工作区干净）
//   node scripts/release-check.mjs --ci   # CI 里跳过工作区检查（checkout 自带临时产物）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = process.argv.includes('--ci');
const errors = [];
const notes = [];

function git(args, timeout = 120000) {
  const r = spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? '';
}
const lines = (s) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

// 私有路径：运行时数据、第三方网关、内部文档、含真实标识的配置。
// 这些即使内容干净也不该进公开仓库的历史。
const PRIVATE_DIR_RE = /^(?:snowluma|tools|data|logs|state|workspaces|models|ops|docs\/internal|docs\/operations)\//;
const PRIVATE_FILE_RE = [
  /^qq-bridge\/config\.json$/,
  /^qq-bridge\/allowlist\.txt$/,
  /^qq-bridge\/(?:state|data|roles|logs)\//,
  /^ai-companion-kit\/.*\/config\.json$/,
  /^ai-companion-kit\/role\.md$/,
];
const isPrivate = (p) => PRIVATE_DIR_RE.test(p) || PRIVATE_FILE_RE.some((re) => re.test(p));

console.log(`[release-check] 仓库根：${ROOT}${ci ? '（--ci 模式）' : ''}`);

// ① 工作区状态：--orphan 会把未提交改动一起带进新历史，发布前必须先收干净。
if (ci) {
  notes.push('CI 模式：跳过工作区检查');
} else {
  const status = lines(git(['status', '--porcelain']));
  if (status.length) errors.push(`工作区有 ${status.length} 处未提交改动；发布前先提交，否则 --orphan 会把中途状态带进公开历史。`);
  else notes.push('工作区干净');
}

const tracked = lines(git(['ls-files']));
if (!tracked.length) errors.push('git ls-files 为空：请在仓库里运行本脚本。');

// ② index 里的私有路径
const inIndex = tracked.filter(isPrivate);
if (inIndex.length) errors.push(`index 里仍有 ${inIndex.length} 个私有文件：${inIndex.slice(0, 8).join(', ')}${inIndex.length > 8 ? ' …' : ''}`);
else notes.push(`index 中无私有路径（${tracked.length} 个已跟踪文件）`);

// ③ 大文件（>5MB 先问值不值得进仓库）
const big = [];
for (const rel of tracked) {
  try {
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isFile() && st.size > 5 * 1024 * 1024) big.push(`${rel} (${Math.round(st.size / 1024 / 1024)}MB)`);
  } catch { /* 文件可能在稀疏 checkout 里不存在 */ }
}
if (big.length) errors.push(`已跟踪文件里有 ${big.length} 个超过 5MB：${big.slice(0, 8).join(', ')}`);
else notes.push('无 >5MB 的已跟踪文件');

// ④ 全仓隐私扫描（qq-bridge/scripts/privacy-scan.mjs 现在以仓库根为扫描根）
const scanner = path.join(ROOT, 'qq-bridge', 'scripts', 'privacy-scan.mjs');
const scan = spawnSync(process.execPath, [scanner, '--json'], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
});
const scanOut = scan.stdout ?? '';
const start = scanOut.indexOf('{');
let scanResult = null;
if (start >= 0) {
  try { scanResult = JSON.parse(scanOut.slice(start)); } catch { /* 下面统一报错 */ }
}
if (!scanResult) {
  errors.push(`全仓隐私扫描没有输出可解析的结果：${(scan.stderr ?? '').slice(0, 300)}`);
} else if (scan.status !== 0 || scanResult.findings?.length) {
  const brief = (scanResult.findings ?? []).slice(0, 5)
    .map((f) => `${f.file}${f.line ? `:${f.line}` : ''} [${f.rule}]`).join('；');
  errors.push(`全仓隐私扫描未通过：${scanResult.findings?.length ?? '?'} 处命中（${brief}）`);
} else {
  notes.push(`全仓隐私扫描通过（${scanResult.scanned} 个文件，0 命中）`);
}
if (scanResult?.incomplete) errors.push('隐私扫描有规则被截断，本次结果不完整，不能判定通过。');

// ⑤ 当前分支历史：--orphan 之后 HEAD 应只剩公开提交。用 HEAD 而不是 --all，
//    因为本地还留着的旧分支不该阻塞发布，但当前要 push 的这条历史必须干净。
//    CI 跳过这一项：日常 PR 不该因为「仓库还没发布过」而变红，它是发布时点的检查。
if (ci) {
  notes.push('CI 模式：跳过历史检查（发布时由本地 release-check 负责）');
} else {
  const historyPaths = [...new Set(lines(git(['log', '--format=', '--name-only', 'HEAD'])))];
  const historyPrivate = historyPaths.filter(isPrivate);
  if (historyPrivate.length) {
    errors.push(`当前分支历史里出现过 ${historyPrivate.length} 个私有路径（如 ${historyPrivate.slice(0, 5).join(', ')}）：必须按 PUBLISHING.md 第三节用 --orphan 重建历史，不能 push 这条历史。`);
  } else {
    notes.push('当前分支历史未检出私有路径');
  }
  const keyCommits = lines(git(['log', '-G', 'sk-[A-Za-z0-9]{16,}', '--format=%h', 'HEAD']));
  if (keyCommits.length) {
    errors.push(`当前分支历史里检出 ${keyCommits.length} 个含 API key 字面量的提交（${keyCommits.slice(0, 5).join(', ')}）：工作树删掉文件没用，必须轮换该密钥并用 --orphan 重建历史。`);
  } else {
    notes.push('当前分支历史未检出 API key 字面量');
  }
}

for (const n of notes) console.log(`  ✅ ${n}`);
for (const e of errors) console.error(`  ❌ ${e}`);

// 这些是人工动作，脚本永远只提示、不代做。
console.log('\n[release-check] 必须人工执行（脚本不会代做）：');
console.log('  1. 轮换所有可能进过历史的令牌：视觉模型 API key、SnowLuma access token、DSH 凭据、控制台 token。');
console.log('  2. 按 docs/PUBLISHING.md 第三节用 git checkout --orphan 建全新历史，并 push 到一个空仓库；');
console.log('     不要在已公开的仓库上 force push，也不要把旧 master 直接推上去。');
console.log('  3. 在 GitHub 打开 Secret scanning / push protection，保护 main 禁止 force push。');

if (errors.length) {
  console.error(`\n[release-check] ❌ 发布阻塞 ${errors.length} 项，尚未就绪。`);
  process.exit(1);
}
console.log('\n[release-check] ✅ 自动检查全部通过；完成上面的人工步骤后即可发布。');
