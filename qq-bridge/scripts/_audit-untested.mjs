import fs from 'node:fs';
import path from 'node:path';

const src = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(entry.name) && !entry.name.includes('.bak')) src.push(p.split(path.sep).join('/'));
  }
};
walk('src');
const tests = [];
for (const dir of ['test', 'scripts']) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (/\.(mjs|js)$/.test(f)) tests.push(path.join(dir, f).split(path.sep).join('/'));
}
const testText = tests.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const untested = src.filter((f) => {
  const base = path.basename(f).replace(/\.(mjs|js)$/, '');
  return !new RegExp(`['"\`](?:\\.\\.\\/)*src\\/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.(?:mjs|js))?['"\`]`).test(testText)
    && !testText.includes(`/${base}.`) && !testText.includes(`\\${base}.`);
});
console.log(`src=${src.length} tests=${tests.length} untested=${untested.length}`);
console.log(untested.join('\n'));
