// 记忆压缩 + 归档分层：纯函数自检（2026-10-26）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCompaction, parseEntries, serializeEntries } from '../src/domain/leaves/inori-compact.js';
import { archiveOld } from '../src/domain/memory/memory-retrieve.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

const DAY = 24 * 3600 * 1000;
const now = Date.parse('2026-10-26T10:00:00Z');
function mkDigest(dayOffset, text) {
  const d = new Date(now - dayOffset * DAY);
  return { day: d.toISOString().slice(0, 10), time: `${d.toISOString().slice(0, 10)} 10:00`, kind: 'group-digest', text };
}

ok('过期且超出保留窗的 digest 被压缩成一条', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push(mkDigest(10 - i * 0.3, `摘要${i}：群里在聊A / B：x`));
  entries.push({ kind: 'fact', text: '群友事实', day: '2026-10-01', time: '2026-10-01 10:00' });
  const plan = planCompaction(entries, { now });
  assert.ok(plan.compacted > 0);
  assert.equal(plan.entries.filter((e) => e.kind === 'group-digest').length, 20);
  assert.equal(plan.entries.filter((e) => e.kind === 'group-compact').length, 1);
  assert.ok(plan.summary.text.startsWith('【压缩】'));
  assert.equal(plan.entries.filter((e) => e.kind === 'fact').length, 1);
});

ok('最近 3 天内的 digest 不动（保新鲜）', () => {
  const entries = [mkDigest(1, '昨天的摘要'), mkDigest(0.5, '今天的摘要'), mkDigest(0.1, '刚聊的摘要')];
  const plan = planCompaction(entries, { now });
  assert.equal(plan.compacted, 0);
});

ok('条目不足保留窗时不动', () => {
  const entries = [mkDigest(30, '很旧的摘要')];
  const plan = planCompaction(entries, { now });
  assert.equal(plan.compacted, 0);
});

ok('非 digest 条目全部保留', () => {
  const entries = [mkDigest(30, '旧摘要'), { kind: 'event', text: '一件事' }, { kind: 'browse', text: '看过' }];
  const plan = planCompaction(entries, { now });
  assert.equal(plan.entries.filter((e) => e.kind === 'event').length, 1);
  assert.equal(plan.entries.filter((e) => e.kind === 'browse').length, 1);
});

ok('parse/serialize 往返', () => {
  const rows = [{ kind: 'fact', text: 'a' }, { kind: 'group-digest', text: 'b' }];
  const back = parseEntries(serializeEntries(rows));
  assert.equal(back.length, 2);
  assert.equal(back[1].text, 'b');
});

ok('归档保留重要事实（importance>=4），旧 digest 进归档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const d10 = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
  const d0 = new Date().toISOString().slice(0, 10);
  const lines = [
    JSON.stringify({ day: d10, time: `${d10} 10:00`, kind: 'fact', text: '重要事实', importance: 5 }),
    JSON.stringify({ day: d10, time: `${d10} 10:00`, kind: 'group-digest', text: '旧摘要', importance: 2 }),
    JSON.stringify({ day: d0, time: `${d0} 10:00`, kind: 'event', text: '今天的事' }),
  ];
  fs.writeFileSync(path.join(dir, 'memory-group_1.jsonl'), lines.join('\n') + '\n');
  const r = archiveOld(dir, { maxAgeDays: 7 });
  const active = fs.readFileSync(path.join(dir, 'memory-group_1.jsonl'), 'utf8');
  assert.ok(r.moved >= 1);
  assert.ok(active.includes('重要事实'), '重要事实应留在活库');
  assert.ok(!active.includes('旧摘要'), '旧 digest 应被归档');
  assert.ok(active.includes('今天的事'), '新条目应留在活库');
  const arch = fs.readFileSync(path.join(dir, '_archive', 'memory-group_1.jsonl'), 'utf8');
  assert.ok(arch.includes('旧摘要'), '归档库里应有旧 digest');
});

import { splitFactsForCap } from '../src/domain/leaves/inori-compact.js';

ok('fact 超限时最旧的进 overflow，其余保留', () => {
  const mk = (i, day) => ({ kind: 'fact', text: 'f' + i, day, time: day + ' 10:00' });
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(mk(i, '2026-10-' + String(10 + i).padStart(2, '0')));
  entries.push({ kind: 'group-digest', text: 'd', day: '2026-10-01', time: '2026-10-01 10:00' });
  const r = splitFactsForCap(entries, { maxFacts: 4 });
  assert.equal(r.keep.filter((e) => e.kind === 'fact').length, 4);
  assert.equal(r.overflow.length, 6);
  assert.equal(r.overflow[0].text, 'f0');
  assert.equal(r.keep.filter((e) => e.kind === 'group-digest').length, 1);
});

ok('fact 未超限不动', () => {
  const entries = [{ kind: 'fact', text: 'a', day: '2026-10-01', time: '2026-10-01 10:00' }];
  const r = splitFactsForCap(entries, { maxFacts: 3 });
  assert.equal(r.overflow.length, 0);
  assert.equal(r.keep.length, 1);
});

console.log(`🎉 记忆压缩/归档分层测试通过（${passed} 项）`);
