// 记忆维护流水线测试：压缩 → fact 上限 → 归档 一条流水线（临时目录）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maintainMemoryDir } from '../src/domain/leaves/inori-memory-maint.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

const DAY = 24 * 3600 * 1000;
const now = Date.parse('2026-10-26T10:00:00Z');
const day = (d) => new Date(now - d * DAY).toISOString().slice(0, 10);
const mk = (kind, text, daysAgo, extra = {}) => ({ day: day(daysAgo), time: `${day(daysAgo)} 10:00`, kind, text, ...extra });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-maint-'));
  const rows = [];
  // 25 条 digest：5 条旧（10 天前）+ 20 条新
  for (let i = 0; i < 5; i++) rows.push(mk('group-digest', `旧摘要${i}`, 10));
  for (let i = 0; i < 20; i++) rows.push(mk('group-digest', `新摘要${i}`, 0.1));
  // 5 条 fact（上限 3 → 2 条最旧溢出）
  for (let i = 0; i < 5; i++) rows.push(mk('fact', `事实${i}`, 10 - i));
  // 1 条 10 天前的 event（>7 天且非重要 → 归档）
  rows.push(mk('event', '旧事件', 10));
  fs.writeFileSync(path.join(dir, 'memory-group_1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

ok('一条流水线：压缩过期 digest + fact 溢出 + 旧条目归档', () => {
  const dir = setup();
  const r = maintainMemoryDir(dir, { afterDays: 3, keepRecentDigests: 20, factCap: 3, archiveAfterDays: 7, now });
  assert.equal(r.files, 1);
  assert.equal(r.compacted, 5);
  assert.equal(r.factsArchived, 2);
  assert.ok(r.archived >= 1);
  const rows = fs.readFileSync(path.join(dir, 'memory-group_1.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.filter((e) => e.kind === 'group-digest').length, 20, '保留最近 20 条 digest');
  assert.equal(rows.filter((e) => e.kind === 'group-compact').length, 1, '多一条压缩摘要');
  assert.equal(rows.filter((e) => e.kind === 'fact').length, 3, 'fact 上限 3');
  const arch = fs.readFileSync(path.join(dir, '_archive', 'memory-group_1.jsonl'), 'utf8');
  assert.ok(arch.includes('事实0') && arch.includes('事实1'), '最旧 2 条 fact 进归档');
  assert.ok(arch.includes('旧事件'), '旧 event 进归档');
});

ok('幂等：再跑一次没有新变化', () => {
  const dir = setup();
  maintainMemoryDir(dir, { afterDays: 3, keepRecentDigests: 20, factCap: 3, archiveAfterDays: 7, now });
  const before = fs.readFileSync(path.join(dir, 'memory-group_1.jsonl'), 'utf8');
  const r2 = maintainMemoryDir(dir, { afterDays: 3, keepRecentDigests: 20, factCap: 3, archiveAfterDays: 7, now });
  assert.equal(r2.compacted, 0);
  assert.equal(r2.factsArchived, 0);
  assert.equal(r2.archived, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'memory-group_1.jsonl'), 'utf8'), before);
});

ok('空目录/不存在目录不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-maint-empty-'));
  const r = maintainMemoryDir(dir, { now });
  assert.equal(r.files, 0);
  assert.equal(r.errors.length, 0);
});

console.log(`🎉 记忆维护流水线测试通过（${passed} 项）`);
