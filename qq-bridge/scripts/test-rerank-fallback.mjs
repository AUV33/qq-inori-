// test-rerank-fallback.mjs · rerank 不可用时静默回退，不影响检索
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recall } from '../src/domain/memory/memory-retrieve.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrfallback-'));
fs.writeFileSync(path.join(dir, 'memory.jsonl'), [
  { time: '2026-10-27 05:00', text: '他家的猫叫团子，挑食' },
  { time: '2026-10-27 06:00', text: '他今天在忙项目' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

(async () => {
  const r = await recall('团子今天又不吃罐头', { dir, scope: 'private', limit: 3, rerankUrl: 'http://127.0.0.1:1/rerank', rerankTimeoutMs: 300 });
  check('rerank 不可用：仍返回结果（静默回退）', () => {
    assert.ok(r.entries.length >= 1, JSON.stringify(r.entries));
    assert.ok(String(r.entries[0].text).includes('团子'), r.entries[0].text);
  });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
