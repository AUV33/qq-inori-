// embed-key：嵌入缓存键带模型+维度（G3 硬验收），且 memory-mcp 与 memory-retrieve 共用同一把钥匙。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { embedKey as sharedEmbedKey, EMBED_MODEL, EMBED_DIM } from '../../ai-companion-kit/packages/shared/embed-key.mjs';
import { embedKey as retrieveEmbedKey } from '../src/domain/memory/memory-retrieve.js';

test('embed-key：常量与公式', () => {
  assert.equal(EMBED_MODEL, 'bge-m3');
  assert.equal(EMBED_DIM, 1024);
  const want = crypto.createHash('sha1').update('bge-m3@1024|你好').digest('hex');
  assert.equal(sharedEmbedKey('你好'), want);
});

test('embed-key：版本化是真实的（不同于裸 sha(text)）', () => {
  const plain = crypto.createHash('sha1').update('你好').digest('hex');
  assert.notEqual(sharedEmbedKey('你好'), plain, '换模型应改变 key，否则旧缓存会污染');
});

test('embed-key：两进程共用同一把钥匙（无重复实现/无漂移）', () => {
  assert.equal(retrieveEmbedKey, sharedEmbedKey, 'memory-retrieve 与 shared 必须是同一函数引用');
  assert.equal(retrieveEmbedKey('同一条'), sharedEmbedKey('同一条'));
});
