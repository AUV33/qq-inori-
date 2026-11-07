import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(entry.name) && !entry.name.includes('.bak')) files.push(p.split(path.sep).join('/'));
  }
};
walk(SRC);
const rows = [];
const re = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/g;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    rows.push({
      file,
      line: i + 1,
      code: lines[i].trim().slice(0, 180),
      before: lines.slice(Math.max(0, i - 2), i).map((x) => x.trim()).filter(Boolean).join(' | ').slice(0, 220),
      after: lines.slice(i + 1, i + 3).map((x) => x.trim()).filter(Boolean).join(' | ').slice(0, 220),
    });
  }
}
const byFile = {};
for (const r of rows) byFile[r.file] = (byFile[r.file] || 0) + 1;
const md = [
  `# 空 catch 全量清单（${rows.length} 处）`,
  '',
  ...Object.entries(byFile).sort((a, b) => b[1] - a[1]).map(([f, n]) => `- ${f}: ${n}`),
  '',
  ...rows.map((r) => `## ${r.file}:${r.line}\n- 前：${r.before || '（无）'}\n- 代码：\`${r.code}\`\n- 后：${r.after || '（无）'}\n`),
].join('\n');
fs.mkdirSync('../data/reports', { recursive: true });
fs.writeFileSync('../data/reports/empty-catch-all-2026-10-31.md', md, 'utf8');
fs.writeFileSync('../data/reports/empty-catch-all-2026-10-31.json', JSON.stringify(rows, null, 2), 'utf8');
console.log(`rows=${rows.length} files=${Object.keys(byFile).length}`);
