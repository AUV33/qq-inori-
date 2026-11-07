// [ATOMIC-2026-11-03] 记忆维护的原子写/锁回归：不丢条、不留碎片、锁失败不写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maintainMemoryDir, compactArchiveDir } from '../src/domain/leaves/inori-memory-maint.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const dayStr = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maint-atomic-'));
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('维护后：主文件仍是合法 JSONL，条目数 = 保留 + 压缩摘要，无 .lock/.tmp 残留', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_1.jsonl');
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ kind: 'group-digest', day: dayStr(30), time: dayStr(30) + ' 10:0' + i, text: '旧' + i })),
    ...Array.from({ length: 20 }, (_, i) => ({ kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:00', text: '新' + i })),
  ];
  writeRows(file, rows);
  const report = maintainMemoryDir(dir, { now: NOW, keepRecentDigests: 20, afterDays: 3 });
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  const after = readRows(file);
  assert.equal(after.length, 21);
  assert.equal(after.filter((x) => x.kind === 'group-compact').length, 1);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.lock') || f.includes('.tmp-')), '不能留下锁/临时文件');
});

test('归档压缩后：归档文件合法、内容数量守恒、无残留', () => {
  const dir = tmpDir();
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch, { recursive: true });
  const file = path.join(arch, 'memory-group_9.jsonl');
  writeRows(file, Array.from({ length: 10 }, (_, i) => ({ kind: 'fact', day: '2026-01-0' + ((i % 9) + 1), text: '旧' + i })));
  const r = compactArchiveDir(dir, { maxLines: 5, keep: 3 });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const after = readRows(file);
  assert.equal(after.length, 4);
  assert.ok(!fs.readdirSync(arch).some((f) => f.endsWith('.lock') || f.includes('.tmp-')));
});

test('锁被占用：返回错误、原文件一字不改、不产生半截写', () => {
  const dir = tmpDir();
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch, { recursive: true });
  const file = path.join(arch, 'memory-group_7.jsonl');
  writeRows(file, Array.from({ length: 10 }, (_, i) => ({ text: '旧' + i })));
  const before = fs.readFileSync(file, 'utf8');
  const lock = file + '.lock';
  fs.writeFileSync(lock, process.pid + ' ' + Date.now(), 'utf8');
  try {
    const r = compactArchiveDir(dir, { maxLines: 5, keep: 3 });
    assert.ok(r.errors.length >= 1, '锁失败必须可见');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '锁失败时不能改写');
  } finally {
    fs.rmSync(lock, { force: true });
  }
});
