// test-memory-classify.mjs · 记忆分类：群之间互不串；私聊翻群时带群号
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recall } from '../src/domain/memory/memory-retrieve.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memclassify-'));
fs.writeFileSync(path.join(dir, 'memory.jsonl'), JSON.stringify({ time: '2026-10-27 05:00', text: '私聊独有内容AAA' }) + '\n');
fs.writeFileSync(path.join(dir, 'memory-group_111.jsonl'), JSON.stringify({ time: '2026-10-27 05:01', text: '一群独有内容BBB' }) + '\n');
fs.writeFileSync(path.join(dir, 'memory-group_222.jsonl'), JSON.stringify({ time: '2026-10-27 05:02', text: '二群独有内容CCC' }) + '\n');
const badEmbed = 'http://127.0.0.1:1';
const opts = { dir, embedUrl: badEmbed, timeoutMs: 400, minSim: 0.05 };

(async () => {
  const g1 = await recall('独有内容', { ...opts, scope: 'group_111', sharePrivate: false });
  check('群 111 检索：只含本群，不串 222/私聊', () => {
    const texts = g1.entries.map((e) => e.text);
    assert.ok(texts.some((x) => x.includes('BBB')), JSON.stringify(texts));
    assert.ok(!texts.some((x) => x.includes('CCC')), '串到二群');
    assert.ok(!texts.some((x) => x.includes('AAA')), '串到私聊');
  });

  const priv = await recall('独有内容', { ...opts, scope: 'private' });
  check('私聊检索：能读各群，且带群号', () => {
    const b = priv.entries.find((e) => e.text.includes('BBB'));
    const c = priv.entries.find((e) => e.text.includes('CCC'));
    assert.ok(b && String(b._groupSource) === '111', JSON.stringify(b?._groupSource));
    assert.ok(c && String(c._groupSource) === '222', JSON.stringify(c?._groupSource));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
