// [FLOOR-LOG] 判定落盘的回归锁：只追加、不抛错、按大小轮转一份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFloorLog } from '../src/domain/shared/floor-log.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'floor-log-'));

test('追加 JSONL：每行一个合法对象，字段原样保留', () => {
  const dir = tmp();
  const file = path.join(dir, 'floor-decisions.jsonl');
  const record = createFloorLog({ file });
  record({ at: '2026-10-28T14:00:00.000Z', key: 'group:1', reply: 0.28, wake: false });
  record({ at: '2026-10-28T14:00:01.000Z', key: 'group:1', reply: 0.9, wake: true, directed: true });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const rows = lines.map((l) => JSON.parse(l));
  assert.equal(rows[0].wake, false);
  assert.equal(rows[1].directed, true);
  assert.equal(rows[1].reply, 0.9);
});

test('超过 maxBytes 时轮转到 .1，主文件只留新写入', () => {
  const dir = tmp();
  const file = path.join(dir, 'floor-decisions.jsonl');
  const record = createFloorLog({ file, maxBytes: 120 });
  for (let i = 0; i < 6; i += 1) record({ at: `t${i}`, key: 'group:1', pad: 'x'.repeat(40) });
  assert.ok(fs.existsSync(`${file}.1`), '应当生成轮转备份');
  assert.ok(fs.statSync(file).size <= 120 + 200, '主文件不应无限增长');
  const backupLines = fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n');
  assert.ok(backupLines.length >= 1);
  // 备份里的行仍可解析
  for (const line of backupLines) assert.ok(JSON.parse(line).key);
});

test('没配 file 或写入失败都不抛（观测失败不挡唤醒）', () => {
  const record = createFloorLog({});
  assert.doesNotThrow(() => record({ a: 1 }));
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const bad = createFloorLog({ file: path.join(blocker, 'sub', 'x.jsonl') });
  assert.doesNotThrow(() => bad({ a: 1 }));
  assert.doesNotThrow(() => bad(null));
});

test('非法行（null/非对象）被忽略', () => {
  const dir = tmp();
  const file = path.join(dir, 'floor-decisions.jsonl');
  const record = createFloorLog({ file });
  record(null);
  record(42);
  record('x');
  assert.equal(fs.existsSync(file), false, '没有合法行就不该建文件');
});
