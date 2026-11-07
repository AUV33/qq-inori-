// inori-memory-maint 金标：单一维护流水线——压缩旧 digest、fact 超限归档、归档库自身压缩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, maintainMemoryDir, compactArchiveDir } from '../src/domain/leaves/inori-memory-maint.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const dayStr = (daysAgo) => iso(daysAgo).slice(0, 10);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maint-'));
}
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('目录不存在：记 errors 并返回空报告（不抛）', () => {
  const r = maintainMemoryDir(path.join(tmpDir(), 'nope'), { now: NOW });
  assert.equal(r.files, 0);
  assert.equal(r.errors.length, 1);
});

test('没有 group 记忆文件：什么都不做', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), '{"text":"私聊"}\n', 'utf8');
  const r = maintainMemoryDir(dir, { now: NOW });
  assert.equal(r.files, 0);
  assert.equal(r.compacted, 0);
});

test('旧 digest 被压成一条 group-compact，并留 .bak 备份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_1.jsonl');
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ kind: 'group-digest', day: dayStr(30), time: `${dayStr(30)} 10:0${i}`, text: `旧摘要${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ kind: 'group-digest', day: dayStr(1), time: `${dayStr(1)} 10:0${i % 10}`, text: `新摘要${i}` })),
  ];
  writeRows(file, rows);
  const r = maintainMemoryDir(dir, { now: NOW, keepRecentDigests: 20, afterDays: 3 });
  assert.equal(r.compacted, 5);
  assert.equal(r.files, 1);
  const after = readRows(file);
  assert.equal(after.filter((x) => x.kind === 'group-compact').length, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('memory-group_1.jsonl.bak-')), '维护前要备份');
});

test('fact 超上限：最旧的进 _archive，主文件只留最新的', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_2.jsonl');
  const rows = Array.from({ length: 5 }, (_, i) => ({ kind: 'fact', day: dayStr(10 - i), time: `${dayStr(10 - i)} 10:00`, text: `事实${i}` }));
  writeRows(file, rows);
  const r = maintainMemoryDir(dir, { now: NOW, factCap: 3 });
  assert.equal(r.factsArchived, 2);
  const after = readRows(file);
  assert.equal(after.length, 3);
  assert.ok(!after.some((x) => x.text === '事实0'), '最旧的被搬走');
  const archived = readRows(path.join(dir, '_archive', 'memory-group_2.jsonl'));
  assert.deepEqual(archived.map((x) => x.text), ['事实0', '事实1']);
});

test('没超限也没可压的：文件不动、不留备份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_3.jsonl');
  writeRows(file, [{ kind: 'fact', day: dayStr(1), time: `${dayStr(1)} 10:00`, text: '新事实' }]);
  const before = fs.statSync(file).mtimeMs;
  const r = maintainMemoryDir(dir, { now: NOW, factCap: 300 });
  assert.equal(r.files, 0);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.bak-')));
});

test('compactArchiveDir：超过 maxLines 的归档文件只留最后 keep 行 + 一条压缩摘要，并备份', () => {
  const dir = tmpDir();
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch, { recursive: true });
  const file = path.join(arch, 'memory-group_9.jsonl');
  const rows = Array.from({ length: 10 }, (_, i) => ({ kind: 'fact', day: `2026-01-0${(i % 9) + 1}`, text: `旧${i}` }));
  writeRows(file, rows);

  const r = compactArchiveDir(dir, { maxLines: 5, keep: 3 });
  assert.equal(r.files, 1);
  assert.equal(r.compacted, 7);
  const after = readRows(file);
  assert.equal(after.length, 4, '3 条保留 + 1 条摘要');
  assert.equal(after[3].kind, 'archive-compact');
  assert.ok(after[3].text.includes('7 条更旧条目'));
  assert.ok(fs.readdirSync(arch).some((f) => f.includes('.bak-')), '压缩归档前要备份');
});

test('compactArchiveDir：未超阈值/没有归档目录 都不动', () => {
  const dir = tmpDir();
  assert.deepEqual(compactArchiveDir(dir), { files: 0, compacted: 0, errors: [] });

  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch, { recursive: true });
  const file = path.join(arch, 'memory-x.jsonl');
  writeRows(file, [{ text: 'a' }, { text: 'b' }]);
  assert.equal(compactArchiveDir(dir, { maxLines: 10 }).files, 0);
});

test('maintainMemoryDir 会顺手压缩归档库并把数字写进报告', () => {
  const dir = tmpDir();
  const arch = path.join(dir, '_archive');
  fs.mkdirSync(arch, { recursive: true });
  const file = path.join(arch, 'memory-group_5.jsonl');
  writeRows(file, Array.from({ length: 8 }, (_, i) => ({ text: `旧${i}` })));
  const r = maintainMemoryDir(dir, { now: NOW, archiveMaxLines: 5, archiveKeep: 2 });
  assert.equal(r.archiveCompacted, 6);
  assert.ok(Array.isArray(r.errors));
});

test('DEFAULTS 是设计值（3 天起压、保留 20 条、fact 上限 300、90 天归档）', () => {
  assert.equal(DEFAULTS.afterDays, 3);
  assert.equal(DEFAULTS.keepRecentDigests, 20);
  assert.equal(DEFAULTS.factCap, 300);
  assert.equal(DEFAULTS.archiveAfterDays, 90);
});

test('retention 上限：超过 maxEntries 时按保留分移出最低分并归档，保护条目保留', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_9.jsonl');
  const rows = [
    { kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:00', text: '低1', importance: 1 },
    { kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:01', text: '低2', importance: 1 },
    { kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:02', text: '低3', importance: 2 },
    { kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:03', text: '重要', importance: 5 },
    { kind: 'group-digest', day: dayStr(1), time: dayStr(1) + ' 10:04', text: '她写的', src: 'her', importance: 1 },
  ];
  writeRows(file, rows);
  const r = maintainMemoryDir(dir, { now: NOW, maxEntries: 3, afterDays: 999 });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.retentionArchived, 2);
  const after = readRows(file);
  assert.equal(after.length, 3);
  assert.ok(after.some((x) => x.text === '重要'));
  assert.ok(after.some((x) => x.text === '她写的'));
  const archived = readRows(path.join(dir, '_archive', 'memory-group_9.jsonl'));
  assert.equal(archived.length, 2);
  assert.ok(!archived.some((x) => x.text === '重要' || x.text === '她写的'));
});

test('consolidate-shadow：报告可合并条数，但不改文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory-group_11.jsonl');
  const base = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  const rows = [
    { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:00', text: base, importance: 3 },
    { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:01', text: base.replace('日', '号'), importance: 4 },
  ];
  writeRows(file, rows);
  const before = fs.readFileSync(file, 'utf8');
  const r = maintainMemoryDir(dir, { now: NOW, afterDays: 999, consolidate: false });
  assert.ok(r.consolidatable >= 1, '应报告可合并条数: ' + r.consolidatable);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '影子模式不能改文件');
});

test('私人 memory.jsonl 也进入维护流水线并被巩固（R5：核心记忆同样合并）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'memory.jsonl');
  const base = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  writeRows(file, [
    { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:00', text: base, importance: 3, recordedAt: iso(1), src: 'private' },
    { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:01', text: base.replace('日', '号'), importance: 4, recordedAt: iso(1), src: 'private' },
    { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:02', text: '他喜欢猫', importance: 2, recordedAt: iso(1), src: 'private' },
  ]);
  const r = maintainMemoryDir(dir, { now: NOW, afterDays: 999, consolidate: true });
  assert.ok(r.consolidated >= 1, '私人记忆应被合并: ' + JSON.stringify(r));
  const after = readRows(file);
  assert.equal(after.length, 2, '两条相似 fact 合并成一条');
  const merged = after.find((e) => e.mergedFrom);
  assert.ok(merged, '合并产物应带 mergedFrom');
  assert.equal(merged.src, 'private', '合并条目保留私人来源溯源');
});

test('consolidate=true：真的合并近重复并写盘；默认 false 不改', () => {
  const base = '主人说自己下周一生日（2026年10月26日），让我记住这件事';
  for (const enabled of [false, true]) {
    const dir = tmpDir();
    const file = path.join(dir, 'memory-group_12.jsonl');
    writeRows(file, [
      { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:00', text: base, importance: 3 },
      { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:01', text: base.replace('日', '号'), importance: 4 },
      { kind: 'fact', day: dayStr(1), time: dayStr(1) + ' 10:02', text: '他喜欢猫', importance: 2 },
    ]);
    const r = maintainMemoryDir(dir, { now: NOW, afterDays: 999, consolidate: enabled });
    const after = readRows(file);
    if (enabled) {
      assert.ok(r.consolidated >= 1, '应合并: ' + JSON.stringify(r));
      assert.equal(after.length, 2, '两条相似 fact 合并成一条');
    } else {
      assert.equal(after.length, 3, '默认不合并');
    }
  }
});
