// test-archive-scope.mjs · 归档记忆按 scope 过滤（群检索不漏私聊归档）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recall } from '../src/domain/memory/memory-retrieve.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memscope-'));
  fs.mkdirSync(path.join(dir, '_archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory-group_1.jsonl'), JSON.stringify({ time: '2026-10-27 05:00', text: '群里正常的一件事' }) + '\n');
  fs.writeFileSync(path.join(dir, '_archive', 'memory.jsonl'), JSON.stringify({ time: '2026-10-01 05:00', text: '私聊归档绝密ABC' }) + '\n');
  fs.writeFileSync(path.join(dir, '_archive', 'memory-group_1.jsonl'), JSON.stringify({ time: '2026-10-02 05:00', text: '群归档旧事XYZ' }) + '\n');
  return dir;
}
const dir = makeDir();
const badEmbed = 'http://127.0.0.1:1';

(async () => {
  const groupNoShare = await recall('私聊归档绝密ABC', { dir, scope: 'group_1', sharePrivate: false, embedUrl: badEmbed, timeoutMs: 500 });
  check('群检索 + sharePrivate=false：不含私聊归档', () => {
    assert.ok(!groupNoShare.entries.some((e) => e.text.includes('绝密ABC')), JSON.stringify(groupNoShare.entries.map((e) => e.text)));
  });

  const groupShare = await recall('私聊归档绝密ABC', { dir, scope: 'group_1', sharePrivate: true, embedUrl: badEmbed, timeoutMs: 500 });
  check('群检索 + sharePrivate=true：含私聊归档并打 _fromPrivate', () => {
    const hit = groupShare.entries.find((e) => e.text.includes('绝密ABC'));
    assert.ok(hit, '没找到私聊归档');
    assert.ok(hit._fromPrivate, '没打来源标签');
  });

  const priv = await recall('群归档旧事XYZ', { dir, scope: 'private', embedUrl: badEmbed, timeoutMs: 500 });
  check('私聊检索：能读群归档并打 _groupSource', () => {
    const hit = priv.entries.find((e) => e.text.includes('旧事XYZ'));
    assert.ok(hit, '没找到群归档');
    assert.ok(hit._groupSource, '没打群来源标签');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
