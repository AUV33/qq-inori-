// 空 catch 盘点（只报告，不改代码）：列出「catch 后没有任何语句」的位置。
// 2026-10-31 修正：旧版只扫 src/*.js，漏掉 .mjs（app/bridge/wake）和子目录，导致 96 的假低值。
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = path.join(PROJECT_ROOT, 'qq-bridge', 'src');
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(entry.name) && !entry.name.includes('.bak')) files.push(p);
  }
};
walk(ROOT);

const out = [];
const re = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/g;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < src.length; i += 1) {
    re.lastIndex = 0;
    if (!re.test(src[i])) continue;
    re.lastIndex = 0;
    const before = src.slice(Math.max(0, i - 2), i).map((x) => x.trim()).filter(Boolean).join(' | ');
    const after = src.slice(i + 1, i + 3).map((x) => x.trim()).filter(Boolean).join(' | ');
    out.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), line: i + 1, code: src[i].trim().slice(0, 180), before, after });
  }
}
const day = new Date().toLocaleDateString('sv-SE');
const OUT = path.join(PROJECT_ROOT, 'data', 'reports');
fs.mkdirSync(OUT, { recursive: true });
const md = [
  `# 空 catch 盘点 · ${day}`,
  '',
  `共 ${out.length} 处（扫描 ${files.length} 个 .js/.mjs，含子目录）`,
  '',
  '| 文件 | 行 | 代码 |',
  '|---|---:|---|',
  ...out.map((o) => `| ${o.file} | ${o.line} | \`${o.code.replaceAll('|', '\\|')}\` |`),
  '',
  '> 判断标准与高危清单见 `docs/internal/_archive/审计/空catch判断-20261031.md`。',
].join('\n');
const file = path.join(OUT, `empty-catch-${day}.md`);
fs.writeFileSync(file, md, 'utf8');
fs.writeFileSync(path.join(OUT, `empty-catch-${day}.json`), JSON.stringify(out, null, 2), 'utf8');
console.log(`empty catches: ${out.length} / files: ${files.length} -> ${file}`);
