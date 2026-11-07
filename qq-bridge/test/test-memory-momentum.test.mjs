// test-memory-momentum.test.mjs · 30 天动量不发散 + 归档可检索（E1/R5 验收回归）
//
// 场景 A（不发散）：30 天每天写一批"会重复出现的主题近重复 + 每天若干条"，每日跑维护
//   （巩固默认开）。断言终值有界、末周趋平——巩固把记忆量压住，不随天数无限膨胀。
// 场景 B（归档可检索）：独立小场景，用很小的 factCap 触发溢出归档，再验证 recall
//   能跨归档捞回最旧的记忆（inArchive 标记）——闭合 R5「归档可检索」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { maintainMemoryDir } from '../src/domain/leaves/inori-memory-maint.js';
import { recall } from '../src/domain/memory/memory-retrieve.js';
import { makeFakeEmbed } from './fake-embed.mjs';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const START = NOW - 29 * DAY;
const dayTime = (i) => START + i * DAY;
const iso = (i) => new Date(dayTime(i)).toISOString();
const dayStr = (i) => iso(i).slice(0, 10);

const VARIANTS = [
  '主人说想减肥，要控制饮食',
  '主人说想减肥要控制饮食',
  '主人说想减肥，控制一下饮食',
];
function dayBatch(i) {
  const rows = VARIANTS.map((t) => ({ kind: 'fact', text: t, time: dayStr(i) + ' 10:00', importance: 2, recordedAt: iso(i), src: 'auto' }));
  for (let j = 0; j < 10; j += 1) {
    rows.push({ kind: 'fact', text: `主人第${i}天记了小事标记为 D${i}N${j}`, time: dayStr(i) + ' 10:00', importance: 1, recordedAt: iso(i), src: 'auto' });
  }
  return rows;
}
const readRows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('场景A · 30 天动量不发散（巩固收敛，终值有界 + 末周趋平）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-momentum-'));
  const file = path.join(dir, 'memory.jsonl');
  const counts = [];
  const totalWritten = 30 * (VARIANTS.length + 10);

  for (let i = 0; i < 30; i += 1) {
    fs.appendFileSync(file, dayBatch(i).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    maintainMemoryDir(dir, { now: dayTime(i), consolidate: true, afterDays: 1, archiveAfterDays: 90, factCap: 120, maxEntries: 2000, consolidateThreshold: 0.85 });
    counts.push(readRows(file).length);
  }

  const finalCount = counts[counts.length - 1];
  assert.ok(finalCount <= 80, `终值应有界（≤80），实际 ${finalCount}`);
  assert.ok(finalCount < totalWritten * 0.4, `巩固应大幅削减总量，终值 ${finalCount} / 累计 ${totalWritten}`);

  const last7 = counts.slice(-7);
  const deltas = last7.slice(1).map((c, k) => c - last7[k]);
  assert.ok(Math.max(...deltas.map((d) => Math.abs(d))) <= 15, `末周单日增量应很小，实际最大 ${Math.max(...deltas.map((d) => Math.abs(d)))}`);
});

test('场景B · 归档可检索（小 factCap 触发溢出归档，recall 跨归档捞回旧记忆）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-archive-'));
  const file = path.join(dir, 'memory.jsonl');
  for (let i = 0; i < 20; i += 1) {
    fs.appendFileSync(file, JSON.stringify({ kind: 'fact', text: `记忆条目 A${i}`, time: '2026-10-01 10:00', importance: 1, recordedAt: '2026-10-01T10:00:00Z', src: 'auto' }) + '\n', 'utf8');
    // consolidate:false 让 factCap 纯驱动归档；factCap=5 → 最旧 15 条进 _archive
    maintainMemoryDir(dir, { now: dayTime(0), consolidate: false, afterDays: 1, archiveAfterDays: 90, factCap: 5, maxEntries: 2000 });
  }

  const archFile = path.join(dir, '_archive', 'memory.jsonl');
  assert.ok(fs.existsSync(archFile), '溢出应产生归档库');
  assert.ok(readRows(archFile).some((e) => e.text.includes('A0')), '最旧条目 A0 应在归档里');

  const r = await recall('A0', { dir, scope: 'private', embed: makeFakeEmbed(), now: NOW, limit: 10, shareGroup: false, searchArchive: true, minSim: 0.15 });
  const hit = r.entries.find((e) => e.text && e.text.includes('A0'));
  assert.ok(hit, '归档里的旧记忆应可被 recall 检索到');
  assert.equal(hit.inArchive, true, '检索到的归档记忆应标 inArchive');
});
