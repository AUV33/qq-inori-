// 架构边界检查：只做“能被源码静态证明”的硬规则，不评价风格。
//
// 为什么需要：项目从 12k 行 app.mjs 拆出 40+ 个服务后，最大的回归风险不是语法，
// 而是边界重新糊回去——某个域偷偷 import app.mjs、纯函数偷偷依赖运行态、
// MCP/OneBot 适配层反向依赖业务。这些错误 node --check 和单测都不一定抓得到。
//
// 规则（违反即 exit 1）：
//   1. 除 app.mjs / bridge.js 外，任何文件不得 import './app.mjs'。
//   2. inori-*.js / pure 模块不得 import 运行态模块（app、*-service、console-server、
//      dsh-client、onebot-transport、runtime-*）。
//   3. mcp-*.js / onebot/* 适配层不得 import app.mjs。
//   4. 新代码放在 src/ 下；本脚本不强制目录迁移，只冻结当前边界。
//
// 用法：node scripts/check-architecture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const violations = [];
const rel = (f) => path.relative(ROOT, f).replaceAll('\\', '/');

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [];
  for (const m of src.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) names.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) names.push(m[1]);
  return names;
}

const RUNTIME_RE = /(^\.{0,2}\/)?(app\.mjs|.*-service\.mjs|console-server\.mjs|dsh-client\.js|onebot-transport\.mjs|runtime-.*\.mjs)$/;

for (const file of files) {
  const name = path.basename(file);
  const r = rel(file);
  const imports = importsOf(file);
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(file), spec);
    const target = path.relative(SRC, resolved).replaceAll('\\', '/');
    // 规则 1
    if (target === 'app.mjs' && name !== 'app.mjs' && name !== 'bridge.js') {
      violations.push(`${r}: 不得 import app.mjs（应通过 createXxx(ctx) 注入）`);
    }
    // 规则 2
    if (/^inori-.*\.js$/.test(name) && RUNTIME_RE.test(target)) {
      violations.push(`${r}: 纯函数模块不得依赖运行态 ${target}`);
    }
    // 规则 3
    if ((/^mcp-.*\.js$/.test(name) || r.includes('/onebot/')) && target === 'app.mjs') {
      violations.push(`${r}: 适配层不得反向依赖 app.mjs`);
    }
  }
}

if (violations.length) {
  console.error('架构边界违规：');
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log(`架构边界检查通过（${files.length} 个源码文件）`);
