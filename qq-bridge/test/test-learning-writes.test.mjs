// [SELF-WRITES] learning-trend 读端 + [SLANG-PRUNE] 僵尸候选清理：纯函数回归锁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLearningWrites, renderLearningWritesLine } from '../src/domain/leaves/inori-learning-writes.js';
import { pruneStaleCandidates } from '../src/domain/social/slang-learner.js';

const NOW = Date.parse('2026-10-28T12:00:00+08:00');
const day = 86400000;

test('学习写入：只算窗口内、只算学习类文件', () => {
  const rows = [
    { at: '2026-10-28T11:00:00+08:00', file: 'lessons.jsonl' },
    { at: '2026-10-28T11:01:00+08:00', file: 'skills.json' },
    { at: '2026-10-28T11:02:00+08:00', file: 'people.json' },
    { at: '2026-10-28T11:03:00+08:00', file: 'attention-gate.log' },
    { at: '2026-10-10T11:00:00+08:00', file: 'lessons.jsonl' }, // 超窗口
  ];
  const s = summarizeLearningWrites(rows, { days: 7, now: NOW });
  assert.equal(s.total, 2);
  assert.deepEqual(s.byBucket, { 经验: 1, 技能: 1 });
});

test('学习写入：rewrite 是内部整理，不计入', () => {
  const rows = [
    { at: '2026-10-28T11:00:00+08:00', op: 'rewrite', file: 'lessons.jsonl' },
    { at: '2026-10-28T11:01:00+08:00', file: 'lessons.jsonl' },
  ];
  const s = summarizeLearningWrites(rows, { days: 7, now: NOW });
  assert.equal(s.total, 1);
});

test('学习写入：空/坏输入安全', () => {
  assert.equal(summarizeLearningWrites(null, { now: NOW }).total, 0);
  assert.equal(renderLearningWritesLine({ total: 0, days: 7, byBucket: {} }), '');
});

test('学习写入：渲染含总数与分项', () => {
  const line = renderLearningWritesLine({ total: 3, days: 7, byBucket: { 经验: 2, 技能: 1 } });
  assert.match(line, /3 次/);
  assert.match(line, /经验 2/);
  assert.match(line, /技能 1/);
});

test('僵尸候选：只出现一次且超期 → stale', () => {
  const old = new Date(NOW - 10 * day).toISOString();
  const { entries, staled } = pruneStaleCandidates([
    { content: 'a', status: 'candidate', count: 1, updatedAt: old },
    { content: 'b', status: 'candidate', count: 2, updatedAt: old },
    { content: 'c', status: 'candidate', count: 1, updatedAt: new Date(NOW - day).toISOString() },
    { content: 'd', status: 'confirmed', count: 1, updatedAt: old },
  ], { days: 7, now: NOW });
  assert.equal(staled, 1);
  assert.equal(entries[0].status, 'stale');
  assert.equal(entries[1].status, 'candidate');
  assert.equal(entries[2].status, 'candidate');
  assert.equal(entries[3].status, 'confirmed');
});

test('僵尸候选：没有时间戳/坏值不动', () => {
  const { staled } = pruneStaleCandidates([{ content: 'x', status: 'candidate', count: 1 }], { days: 7, now: NOW });
  assert.equal(staled, 0);
});

test('学习写入：rewrite 只按增量计（新增经验算、整理不算）', () => {
  const rows = [
    { at: '2026-10-28T10:00:00+08:00', op: 'rewrite', file: 'lessons.jsonl', rows: 30 },
    { at: '2026-10-28T10:01:00+08:00', op: 'rewrite', file: 'lessons.jsonl', rows: 30 }, // 整理，不算
    { at: '2026-10-28T10:02:00+08:00', op: 'rewrite', file: 'lessons.jsonl', rows: 34 }, // 新增 4 条
    { at: '2026-10-28T10:03:00+08:00', op: 'rewrite', file: 'lessons.jsonl', rows: 32 }, // 变少，不算
  ];
  const s = summarizeLearningWrites(rows, { days: 7, now: NOW });
  assert.equal(s.byBucket['经验'], 4);
});
