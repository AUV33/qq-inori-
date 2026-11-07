// inori-embed-prune 金标：向量缓存只留「记忆里还有的文本」；记忆文件没了就整份删；坏缓存不炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneEmbeddingCaches } from '../src/domain/leaves/inori-embed-prune.js';
import { embedKey } from '../../ai-companion-kit/packages/shared/embed-key.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-embed-'));

function writeMem(dir, name, texts) {
  fs.writeFileSync(path.join(dir, name), texts.map((t) => JSON.stringify({ text: t })).join('\n') + '\n', 'utf8');
}
function writeCache(dir, name, map) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(map), 'utf8');
}

test('记忆里还存在的文本保留，过期的键删掉', () => {
  const dir = tmp();
  writeMem(dir, 'memory.jsonl', ['还在的一句']);
  writeCache(dir, 'embeddings.json', { [embedKey('还在的一句')]: [1, 2], [embedKey('已经不在的一句')]: [3, 4] });
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.files, 1);
  assert.equal(r.dropped, 1);
  assert.equal(r.removedFiles, 0);
  assert.deepEqual(r.errors, []);
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'embeddings.json'), 'utf8'));
  assert.deepEqual(Object.keys(left), [embedKey('还在的一句')]);
});

test('按 scope 找对应记忆文件（embeddings-<scope> ↔ memory-<scope>）', () => {
  const dir = tmp();
  writeMem(dir, 'memory-group_1.jsonl', ['群里的句子']);
  writeCache(dir, 'embeddings-group_1.json', { [embedKey('群里的句子')]: [1], [embedKey('别的')]: [2] });
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.files, 1);
  assert.equal(r.dropped, 1);
});

test('记忆文件不存在 → 整份缓存删掉（群被移出白名单的情况）', () => {
  const dir = tmp();
  writeCache(dir, 'embeddings-gone.json', { abc: [1] });
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.removedFiles, 1);
  assert.equal(fs.existsSync(path.join(dir, 'embeddings-gone.json')), false);
});

test('没有过期键时不重写文件（files=0）', () => {
  const dir = tmp();
  writeMem(dir, 'memory.jsonl', ['一句话']);
  const file = path.join(dir, 'embeddings.json');
  writeCache(dir, 'embeddings.json', { [embedKey('一句话')]: [1] });
  const before = fs.statSync(file).mtimeMs;
  const r = pruneEmbeddingCaches(dir);
  assert.equal(r.files, 0);
  assert.equal(r.dropped, 0);
  assert.equal(fs.statSync(file).mtimeMs, before, '没必要就不动文件');
});

test('坏缓存 JSON 当空处理（不会把整个清理搞崩）', () => {
  const dir = tmp();
  writeMem(dir, 'memory.jsonl', ['一句话']);
  fs.writeFileSync(path.join(dir, 'embeddings.json'), '{不是 JSON', 'utf8');
  const r = pruneEmbeddingCaches(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(r.files, 0, '空缓存没有可删的键');
});

test('目录不可读 → 记 errors 并返回空报告，不抛', () => {
  const r = pruneEmbeddingCaches(path.join(os.tmpdir(), 'qq-embed-not-exist-xyz'));
  assert.equal(r.files, 0);
  assert.equal(r.dropped, 0);
  assert.equal(r.errors.length, 1);
});

test('只认 embeddings*.json，不碰其它文件', () => {
  const dir = tmp();
  writeMem(dir, 'memory.jsonl', ['x']);
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"keep":1}', 'utf8');
  writeCache(dir, 'embeddings.json', { [embedKey('old')]: [1] });
  pruneEmbeddingCaches(dir);
  assert.equal(fs.existsSync(path.join(dir, 'notes.json')), true);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'), '{"keep":1}');
});
