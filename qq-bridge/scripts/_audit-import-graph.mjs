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
const importers = new Map(files.map((f) => [f, new Set()]));
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    let target = path.normalize(path.join(path.dirname(f), spec)).split(path.sep).join('/');
    if (!/\.(mjs|js)$/.test(target)) {
      if (fs.existsSync(target + '.mjs')) target += '.mjs';
      else if (fs.existsSync(target + '.js')) target += '.js';
      else if (fs.existsSync(path.join(target, 'index.mjs'))) target = path.join(target, 'index.mjs').split(path.sep).join('/');
      else continue;
    }
    if (importers.has(target)) importers.get(target).add(f);
  }
}
const entries = new Set(['src/bridge.js', 'src/app.mjs', 'src/config-check.mjs']);
const dead = files.filter((f) => importers.get(f).size === 0 && !entries.has(f));
console.log(`files=${files.length} dead=${dead.length}`);
console.log(dead.join('\n'));
console.log('\nMost imported:');
console.log([...importers].sort((a, b) => b[1].size - a[1].size).slice(0, 20).map(([f, s]) => `${s.size}\t${f}`).join('\n'));
