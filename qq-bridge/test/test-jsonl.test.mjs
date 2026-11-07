// [JSONL] 共享 JSONL 读写契约：坏行跳过、文件缺失返回空、可注入 fs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, appendJsonl } from '../src/domain/leaves/jsonl.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-jsonl-'));

test('读：正常行解析、空行跳过', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, '{"a":1}\n\n{"a":2}\n', 'utf8');
  assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }]);
});

test('读：坏行容错跳过，不抛错', () => {
  const dir = tmp();
  const file = path.join(dir, 'b.jsonl');
  fs.writeFileSync(file, '{"ok":1}\nnot-json\n{"ok":2}\n', 'utf8');
  assert.deepEqual(readJsonl(file), [{ ok: 1 }, { ok: 2 }]);
});

test('读：文件不存在返回空数组', () => {
  assert.deepEqual(readJsonl(path.join(tmp(), 'missing.jsonl')), []);
});

test('读：可注入 fs（测试桩）', () => {
  const fake = { readFileSync: () => '{"x":1}\n' };
  assert.deepEqual(readJsonl('/whatever', { fs: fake }), [{ x: 1 }]);
});

test('写：追加一行，可被读回', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '{"first":true}\n', 'utf8');
  appendJsonl(file, { second: true });
  assert.deepEqual(readJsonl(file), [{ first: true }, { second: true }]);
});

test('写：可注入 fs', () => {
  const calls = [];
  const fake = { appendFileSync: (...args) => calls.push(args) };
  appendJsonl('/x', { a: 1 }, { fs: fake });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '{"a":1}\n');
});
