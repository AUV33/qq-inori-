// quant/store 金标：原子写、JSONL 追加/读取、坏行与目录缺失都不炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, appendJsonl, readJsonl } from '../src/quant/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-quant-'));

test('writeJsonAtomic：自动建目录、写成带缩进的 JSON，且不留 .tmp', () => {
  const dir = tmp();
  const file = path.join(dir, 'deep', 'dir', 'state.json');
  const r = writeJsonAtomic(file, { a: 1, b: [2] });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: [2] });
  assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.tmp-')), false, '临时文件必须被 rename 掉');
});

test('writeJsonAtomic：覆盖已有文件是原子替换（读到的永远是完整 JSON）', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2, extra: 'x' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2, extra: 'x' });
});

test('writeJsonAtomic：路径不可写时返回 {ok:false}，不抛错', () => {
  const dir = tmp();
  const file = path.join(dir, 'no', 'way', 'x.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.chmodSync(path.dirname(file), 0o500); // 只读目录
  try {
    const r = writeJsonAtomic(file, { a: 1 });
    if (process.platform === 'win32') return; // Windows 上 chmod 不生效，跳过
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  } finally {
    try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* 清理失败无妨 */ }
  }
});

test('appendJsonl：一行一个 JSON，目录自动建', () => {
  const dir = tmp();
  const file = path.join(dir, 'a', 'rows.jsonl');
  assert.deepEqual(appendJsonl(file, { n: 1 }), { ok: true });
  appendJsonl(file, { n: 2 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { n: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { n: 2 });
});

test('readJsonl：坏行跳过、空文件与不存在都返回 []', () => {
  const dir = tmp();
  const file = path.join(dir, 'r.jsonl');
  fs.writeFileSync(file, '{"a":1}\n坏行\n\n{"a":2}\n', 'utf8');
  assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }]);
  fs.writeFileSync(file, '', 'utf8');
  assert.deepEqual(readJsonl(file), []);
  assert.deepEqual(readJsonl(path.join(dir, 'nope.jsonl')), []);
});

test('appendJsonl 与 readJsonl 往返一致', () => {
  const dir = tmp();
  const file = path.join(dir, 'rt.jsonl');
  const rows = [{ t: 'buy', qty: 1 }, { t: 'sell', qty: 1.5 }];
  for (const r of rows) appendJsonl(file, r);
  assert.deepEqual(readJsonl(file), rows);
});
