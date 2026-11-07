import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactArchiveDir } from '../src/domain/leaves/inori-memory-maint.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('归档文件超限 → 留最近 keep 行 + 一条压缩摘要', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-compact-'));
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch);
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(JSON.stringify({ day: '2026-01-' + String(i + 1).padStart(2, '0'), time: '2026-01-01 10:00', kind: 'event', text: 'old' + i }));
  fs.writeFileSync(path.join(arch, 'memory-group_9.jsonl'), rows.join('\n') + '\n');
  const r = compactArchiveDir(dir, { maxLines: 5, keep: 3 });
  assert.equal(r.files, 1);
  assert.equal(r.compacted, 9);
  const lines = fs.readFileSync(path.join(arch, 'memory-group_9.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.kind, 'archive-compact');
});

ok('未超限不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-compact2-'));
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch);
  fs.writeFileSync(path.join(arch, 'memory-group_9.jsonl'), JSON.stringify({ kind: 'event', text: 'x' }) + '\n');
  const r = compactArchiveDir(dir, { maxLines: 5, keep: 3 });
  assert.equal(r.files, 0);
});

console.log(`🎉 归档压缩测试通过（${passed} 项）`);
