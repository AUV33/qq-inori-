// guard-scan.mjs · self-edit-guard 的纯函数部分（可单测，不碰进程/定时器）
//
// 为什么单独抽出来：护栏的「扫哪些文件」「备份叫什么名字」是它最容易出错的逻辑 ——
// 扫漏了等于没有护栏，备份名撞了等于回滚错文件。这两件事不该只能靠「跑起来看看」。

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.venv', 'dist', 'build', '.git', 'test', '__tests__', 'coverage']);
const CODE_EXT = new Set(['.js', '.mjs']);

export function isCodeFile(name) {
  return CODE_EXT.has(path.extname(name).toLowerCase());
}

/**
 * 哪些文件需要「运行时冒烟」而不只是 node --check。
 * 2026-10-28 拆成 bridge.js（入口壳）+ app.mjs（全部实现）之后，
 * 真正要冒烟的是**整个入口链**，所以这两个名字都算，且都跑 bridge.js 这一条壳。
 */
const SMOKE_NAMES = new Set(['bridge.js', 'app.mjs']);
export function needsSmoke(file) {
  return SMOKE_NAMES.has(path.basename(file));
}

/** 递归收集 dir 下的 .js/.mjs（跳过 node_modules/dist/test 之类） */
export function walkCode(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkCode(full, out, depth + 1); continue; }
    if (e.isFile() && isCodeFile(e.name)) out.push(full);
  }
  return out;
}

/**
 * 要监控的代码文件清单：<bridge>/src/*.js + <packagesRoot>/<pkg>/src/**\/*.{js,mjs}
 * @param {object} opts { srcDir, packagesRoot }
 * @returns {string[]}
 */
export function collectCodeFiles({ srcDir, packagesRoot }) {
  const out = [];
  try {
    out.push(...fs.readdirSync(srcDir)
      .filter(isCodeFile)
      .map((f) => path.join(srcDir, f)));
  } catch { /* ignore */ }

  try {
    for (const pkg of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      if (SKIP_DIRS.has(pkg.name)) continue;
      const pkgSrc = path.join(packagesRoot, pkg.name, 'src');
      if (fs.existsSync(pkgSrc)) walkCode(pkgSrc, out);
    }
  } catch { /* 没有 ai-companion-kit 也不影响桥接护栏 */ }

  return out;
}

/**
 * 备份文件名：qq-bridge/src 下保持原来的 basename（兼容既有 .good.js），
 * 其它根用「相对路径转义」，避免各包的 index.js 互相覆盖同一份备份。
 * @param {string} file
 * @param {object} opts { projectRoot, srcDir }
 * @returns {string} 不含目录的文件名（调用方自己拼 BACKUP）
 */
export function backupNameFor(file, { projectRoot, srcDir }) {
  const resolved = path.resolve(file);
  const inBridgeSrc = path.dirname(resolved) === path.resolve(srcDir);
  if (inBridgeSrc) return path.basename(resolved) + '.good.js';
  const rel = path.relative(projectRoot, resolved).split(path.sep).join('__');
  return rel + '.good.js';
}
