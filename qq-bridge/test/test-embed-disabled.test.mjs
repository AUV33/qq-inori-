// test-embed-disabled.test.mjs · 低内存模式：QQ_INORI_EMBED_DISABLED=1 时桥接不得自动拉起嵌入服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/adapters/console-server.mjs'), 'utf8');

test('EMBED-OFF 开关：在 alive 检查/拉起之前直接返回', () => {
  const at = src.indexOf('QQ_INORI_EMBED_DISABLED');
  assert.ok(at > 0);
  const block = src.slice(at, at + 600);
  assert.match(block, /return;/);
  assert.ok(block.indexOf('spawn(') === -1, '不得走到 spawn');
  assert.match(block, /字面模式/);
});
