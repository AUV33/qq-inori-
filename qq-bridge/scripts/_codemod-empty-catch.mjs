import fs from 'node:fs';
import path from 'node:path';

const rows = JSON.parse(fs.readFileSync('../data/reports/empty-catch-2026-10-31.json', 'utf8'));
const byFile = new Map();
for (const row of rows) {
  if (!byFile.has(row.file)) byFile.set(row.file, []);
  byFile.get(row.file).push(row);
}
let changed = 0;
for (const [rel, list] of byFile) {
  const file = path.join('src', rel);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // 先按原始行号降序处理，避免改行导致错位；每行只做一次替换。
  const seen = new Set();
  for (const row of list.sort((a, b) => b.line - a.line)) {
    const idx = row.line - 1;
    if (idx < 0 || idx >= lines.length || seen.has(idx)) continue;
    seen.add(idx);
    const re = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[^*]*\*\/\s*)?\}/;
    if (!re.test(lines[idx])) continue;
    const label = `${rel}:${row.line}`;
    lines[idx] = lines[idx].replace(re, `catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, '${label}'); }`);
    changed += 1;
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}
console.log(`rewritten=${changed} files=${byFile.size}`);
