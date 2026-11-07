import fs from 'node:fs';
import path from 'node:path';

const root = 'src';
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(entry.name) && !entry.name.includes('.bak')) files.push(p.split(path.sep).join('/'));
  }
};
walk(root);
const allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const rows = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const names = [];
  for (const m of s.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
  for (const m of s.matchAll(/export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
  for (const name of new Set(names)) {
    const count = (allText.match(new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`, 'g')) || []).length;
    // 只在定义文件出现 1 次 = 没有任何外部引用；2 次可能只是导出+内部用
    if (count <= 1) rows.push({ file: f, name, count });
  }
}
console.log(`unused-ish exports: ${rows.length}`);
for (const r of rows) console.log(`${r.name}\t${r.file}`);
