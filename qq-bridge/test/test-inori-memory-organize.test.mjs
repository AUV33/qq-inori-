// inori-memory-organize 金标：只做机械识别（完全重复/近似重复/旧快照族），产出候选不动数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, normalizeText, bigrams, similarity, findExactDuplicates, findNearDuplicates,
  snapshotFamily, outdatedSnapshots, buildIndex, planOrganize, describePlan, mergeEntries,
} from '../src/domain/leaves/inori-memory-organize.js';

const entry = (text, over = {}) => ({ text, time: '2026-11-01 10:00', ...over });

test('normalizeText / bigrams / similarity：去空白与标点，二元组 Jaccard', () => {
  assert.equal(normalizeText(' 你好，世界！ '), '你好世界');
  assert.equal(bigrams('你好世界').size, 3, '四字 → 三个二元组');
  assert.equal(similarity('你好世界', '你好世界'), 1);
  assert.equal(similarity('你好世界', '完全不同'), 0);
  assert.equal(similarity('', 'x'), 0);
});

test('findExactDuplicates：去掉空白后完全相同才成组', () => {
  const groups = findExactDuplicates([entry('同一句'), entry(' 同一句 '), entry('别的')]);
  assert.deepEqual(groups, [[0, 1]]);
  assert.deepEqual(findExactDuplicates([entry('唯一')]), []);
  assert.deepEqual(findExactDuplicates(null), []);
});

test('findNearDuplicates：够长且相似度达标才成对，按分数降序', () => {
  // nearMinLen=20：句子要够长才会参与近似比较
  const long = '群里在聊周末大家一起去哪里爬山以及要带什么装备这件事';
  const near = long + '呀';
  const pairs = findNearDuplicates([entry(long), entry(near), entry('完全无关的另一段很长很长的话内容完全不同的一段文字')]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].i, 0);
  assert.equal(pairs[0].j, 1);
  assert.ok(pairs[0].score >= DEFAULTS.nearThreshold);

  assert.deepEqual(findNearDuplicates([entry('短句'), entry('短句')]), [], '太短不比');
});

test('snapshotFamily：三个族各自识别，未知/太短返回 null', () => {
  assert.deepEqual(snapshotFamily('近 24h 群像：发言最多 小明'), { family: 'group-portrait', keep: 1 });
  assert.deepEqual(snapshotFamily('想自己待会儿，但连着 3 次都正忙（累计 5 次）'), { family: 'wish-retry', keep: 1 });
  assert.deepEqual(snapshotFamily('今天网上看过：显卡选购'), { family: 'browse-digest', keep: 3 });
  assert.equal(snapshotFamily('普通事实'), null);
  assert.equal(snapshotFamily('短'), null);
});

test('outdatedSnapshots：每族只留最近 keep 份，其余列为可归档', () => {
  const entries = [
    entry('近 24h 群像：旧', { time: '2026-10-30 10:00' }),
    entry('近 24h 群像：新', { time: '2026-11-01 10:00' }),
    entry('今天网上看过：a', { time: '2026-10-28 10:00' }),
    entry('今天网上看过：b', { time: '2026-10-29 10:00' }),
    entry('今天网上看过：c', { time: '2026-10-30 10:00' }),
    entry('今天网上看过：d', { time: '2026-11-01 10:00' }),
    entry('普通事实不动', { time: '2026-01-01 10:00' }),
  ];
  const r = outdatedSnapshots(entries);
  assert.deepEqual(r.archive.map((x) => x.index), [0, 2], '群像留最新 1，冲浪留最近 3');
  assert.deepEqual(r.kept, { 'group-portrait': 1, 'browse-digest': 3 });
});

test('buildIndex：按 kind/theme/day 计数；无主题的（day-digest 除外）单独列', () => {
  const idx = buildIndex([
    { kind: 'fact', theme: '日常', day: '2026-11-01' },
    { kind: 'fact', day: '2026-11-01' },
    { kind: 'day-digest', day: '2026-11-01' },
  ]);
  assert.equal(idx.total, 3);
  assert.deepEqual(idx.byKind, { fact: 2, 'day-digest': 1 });
  assert.deepEqual(idx.byTheme, { 日常: 1 });
  assert.deepEqual(idx.byDay, { '2026-11-01': 3 });
  assert.deepEqual(idx.noTheme, [1], 'day-digest 不进无主题列表');
});

test('planOrganize：产出归档索引/完全重复组/近似对/索引，而且不动原数组', () => {
  const entries = [
    entry('近 24h 群像：旧', { time: '2026-10-30 10:00' }),
    entry('近 24h 群像：新', { time: '2026-11-01 10:00' }),
    entry('重复的一句'),
    entry('重复的一句'),
  ];
  const snapshot = JSON.stringify(entries);
  const plan = planOrganize(entries);
  assert.deepEqual(plan.archiveIndexes, [0]);
  assert.deepEqual(plan.exactGroups, [[2, 3]]);
  assert.equal(plan.total, 4);
  assert.equal(plan.summary.archive, 1);
  assert.equal(plan.summary.exactDupGroups, 1);
  assert.equal(JSON.stringify(entries), snapshot, '只描述不动数据');
});

test('describePlan：只列非零项；空计划返回「共 N 条」', () => {
  assert.equal(describePlan({ total: 0 }), '共 0 条');
  const text = describePlan({ total: 5, summary: { archive: 2, nearPairs: 1, noTheme: 3 } });
  assert.ok(text.includes('旧快照可归档 2 条'));
  assert.ok(text.includes('近似重复 1 对'));
  assert.ok(text.includes('无主题 3 条'));
  assert.ok(!text.includes('完全重复'));
  assert.equal(describePlan(null), '');
});

test('mergeEntries：单条返回副本；多条保留最新文本、最早时间、合并元信息与 mentions 并集', () => {
  const entries = [
    { text: '旧文本', day: '2026-10-30', time: '2026-10-30 10:00', importance: 2, mentions: ['a'], who: '甲', theme: '旧' },
    { text: '新文本', day: '2026-11-01', time: '2026-11-01 12:00', importance: 4, mentions: ['b', 'a'], felt: '开心' },
  ];
  const one = mergeEntries(entries, [0]);
  assert.deepEqual(one, { ...entries[0] });
  assert.notEqual(one, entries[0], '返回副本');

  const merged = mergeEntries(entries, [0, 1]);
  assert.equal(merged.text, '新文本');
  assert.equal(merged.day, '2026-10-30');
  assert.equal(merged.time, '2026-10-30 10:00');
  assert.equal(merged.importance, 4);
  assert.deepEqual(merged.mentions, ['a', 'b']);
  assert.equal(merged.who, '甲');
  assert.equal(merged.felt, '开心');
  assert.equal(merged.mergedFrom, 2);
  assert.ok(merged.mergedAt);

  assert.equal(mergeEntries(entries, []), null);
  assert.equal(mergeEntries(entries, [99]), null);
});
