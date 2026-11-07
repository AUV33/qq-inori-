// 向量缓存清理：只留记忆里还存在的文本的向量；孤儿缓存文件删除
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pruneEmbeddingCaches } from '../src/domain/leaves/inori-embed-prune.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

ok('清掉记忆里已不存在的向量，保留仍存在的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-prune-'));
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), JSON.stringify({ kind: 'fact', text: '还记得的事' }) + '\n');
  fs.writeFileSync(path.join(dir, 'memory-group_9.jsonl'), JSON.stringify({ kind: 'group-digest', text: '群摘要' }) + '\n');
  fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify({ [sha1('还记得的事')]: [1, 2], [sha1('早忘了的事')]: [3] }));
  fs.writeFileSync(path.join(dir, 'embeddings-group_9.json'), JSON.stringify({ [sha1('群摘要')]: [1], [sha1('过期摘要')]: [2] }));
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.dropped, 2);
  const c1 = JSON.parse(fs.readFileSync(path.join(dir, 'embeddings.json'), 'utf8'));
  assert.deepEqual(Object.keys(c1), [sha1('还记得的事')]);
  const c2 = JSON.parse(fs.readFileSync(path.join(dir, 'embeddings-group_9.json'), 'utf8'));
  assert.deepEqual(Object.keys(c2), [sha1('群摘要')]);
});

ok('记忆文件不存在的孤儿缓存整份删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-prune2-'));
  fs.writeFileSync(path.join(dir, 'embeddings-group_404.json'), JSON.stringify({ abc: [1] }));
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.removedFiles, 1);
  assert.equal(fs.existsSync(path.join(dir, 'embeddings-group_404.json')), false);
});

ok('没有失效项时不动文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-prune3-'));
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), JSON.stringify({ kind: 'fact', text: 'x' }) + '\n');
  fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify({ [sha1('x')]: [1] }));
  const before = fs.readFileSync(path.join(dir, 'embeddings.json'), 'utf8');
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.dropped, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'embeddings.json'), 'utf8'), before);
});

console.log(`🎉 向量缓存清理测试通过（${passed} 项）`);
