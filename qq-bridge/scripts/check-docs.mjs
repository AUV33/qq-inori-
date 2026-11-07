#!/usr/bin/env node
// check-docs.mjs · 文档纪律的轻量门禁
//
// 只做三件事：
//   1. 必读文档存在且非空；
//   2. 这些 Markdown 里的本地 .md 链接能解析到真实文件；
//   3. 每个变更记录都含「改了什么/为什么/验证/回滚」四段。
//
// 不检查措辞、不检查覆盖率；目的是防止“代码改了、文档没留”。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..');
const ROOT = path.resolve(BRIDGE, '..');

const REQUIRED_PUBLIC = [
  'docs/README.md',
  'docs/ENGINEERING_DISCIPLINE.md',
  'docs/architecture.md',
  'docs/architecture-full.md',
  'docs/deployment.md',
  'qq-bridge/src/onebot/README.md',
];

// docs/internal 在本机存在，但公开仓库被 .gitignore 排除；存在时才要求。
// [DOCS-CONSOLIDATED] 2026-11-05：108 份内部文档合并为 10 份权威文档，
// 原文归档在 docs/internal/_archive/（只读史料，不再要求四段校验）。
const REQUIRED_INTERNAL = [
  'docs/internal/README.md',
  'docs/internal/现状.md',
  'docs/internal/架构.md',
  'docs/internal/路线与缺口.md',
  'docs/internal/记忆系统.md',
  'docs/internal/学习与认知.md',
  'docs/internal/运维手册.md',
  'docs/internal/模块地图.md',
  'docs/internal/变更记录.md',
  'docs/internal/文档规范.md',
];
const INTERNAL_DIR = path.join(ROOT, 'docs', 'internal');
const hasInternal = fs.existsSync(INTERNAL_DIR);
const REQUIRED = hasInternal ? [...REQUIRED_PUBLIC, ...REQUIRED_INTERNAL] : REQUIRED_PUBLIC;

const LOCAL_DOCS = [...REQUIRED_PUBLIC, ...REQUIRED_INTERNAL];

const errors = [];
for (const rel of REQUIRED) {
  const abs = path.join(ROOT, rel);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { errors.push(`缺少必读文档：${rel}`); continue; }
  if (!text.trim()) errors.push(`文档为空：${rel}`);
}

for (const rel of LOCAL_DOCS) {
  const abs = path.join(ROOT, rel);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const dir = path.dirname(abs);
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].trim();
    if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
    if (target.startsWith('<') && target.endsWith('>')) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean.endsWith('.md')) continue;
    const resolved = path.resolve(dir, decodeURIComponent(clean));
    if (!fs.existsSync(resolved)) errors.push(`${rel} 的链接不存在：${target}`);
  }
}

// [AUDIT-FIX] 反引号里写的源码路径也要能解析到真实文件。
// 旧检查只认 .md 链接（上面 :66 直接 continue），所以 src/domain/ 重构后
// 公开文档里大量 `src/inori-*.js` 旧路径一直没被发现。
// 只扫公开必读文档：docs/internal 的变更记录是历史史料，允许保留旧路径。
const CODE_PATH_RE = /`((?:qq-bridge\/)?src\/[A-Za-z0-9_./-]+\.(?:js|mjs|json|yml))`/g;
for (const rel of REQUIRED_PUBLIC) {
  const abs = path.join(ROOT, rel);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  for (const m of text.matchAll(CODE_PATH_RE)) {
    const relPath = m[1].startsWith('qq-bridge/') ? m[1] : `qq-bridge/${m[1]}`;
    if (!fs.existsSync(path.resolve(ROOT, relPath))) {
      errors.push(`${rel} 引用的源码路径不存在：${m[1]}`);
    }
  }
}

// [CHANGELOG-MERGED] 变更记录合并为单文件：每条以 `## YYYY-MM-DD · 标题` 开头，
// 必须含「改了什么 / 为什么 / 验证 / 回滚」四段。历史逐文件记录已归档，不再逐份校验。
let recordCount = 0;
if (hasInternal) {
  const changelog = path.join(ROOT, 'docs', 'internal', '变更记录.md');
  let text = '';
  try { text = fs.readFileSync(changelog, 'utf8'); } catch { /* REQUIRED 已报缺失 */ }
  const entries = text.split(/^## \d{4}-\d{2}-\d{2} · /m).slice(1);
  recordCount = entries.length;
  if (text.trim() && !recordCount) errors.push('变更记录.md 里没有「## YYYY-MM-DD · 标题」条目');
  entries.forEach((entry, i) => {
    const title = entry.split('\n')[0].trim() || `第 ${i + 1} 条`;
    for (const key of ['改了什么', '为什么', '验证', '回滚']) {
      if (!entry.includes(key)) errors.push(`变更记录.md「${title}」缺少「${key}」段`);
    }
  });
}

// [BASELINE-DRIFT] 文档里写死的模块数会随时间变化，但**历史快照是事实，不是漂移**：
// 早期文档写 200/177/269 个模块，记录的是当时的真实规模，一律报错只会让门禁误伤。
// 因此只硬校验显式标注「当前基线」的那一行；其余数字仅作信息输出。
let baselineNote = '';
try {
  const { buildMatrix } = await import('./module-matrix.mjs');
  const actualModules = buildMatrix().rows.length;
  if (hasInternal) {
    const docs = fs.readdirSync(INTERNAL_DIR).filter((n) => n.endsWith('.md'));
    const baselineRe = /(\d{3,4})\s*个模块/g;
    let seen = 0;
    for (const name of docs) {
      const lines = fs.readFileSync(path.join(INTERNAL_DIR, name), 'utf8').split('\n');
      for (const line of lines) {
        for (const m of line.matchAll(baselineRe)) {
          seen += 1;
          const claimed = Number(m[1]);
          const isCurrent = /当前基线|当前模块|现状|实测口径/.test(line);
          if (isCurrent && Math.abs(claimed - actualModules) > 3) {
            errors.push(`${name} 的「当前基线」写 ${claimed} 个模块，实测 ${actualModules}（基线漂移）`);
          }
        }
      }
    }
    baselineNote = `，模块基线 ${actualModules}（文档 ${seen} 处数字，仅校验当前基线）`;
  }
} catch (error) {
  // 矩阵模块不可用时不阻断文档检查（CI 上 docs/internal 缺失本就跳过）。
  void error;
}

if (errors.length) {
  console.error('DOCS_CHECK_FAILED');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log(`DOCS_OK（${REQUIRED.length} 份必读文档，变更记录 ${recordCount} 条${baselineNote}）`);
