// inori-compact 金标：记忆压缩（只压过期 group-digest，保留最近 N 条原文，压成一条 group-compact）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, planCompaction, splitFactsForCap, parseEntries, serializeEntries } from '../src/domain/leaves/inori-compact.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const digest = (daysAgo, text = '群里在聊：某件事') => ({
  kind: 'group-digest',
  day: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10),
  time: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + ' 10:00',
  text,
});

test('planCompaction：没有可压的（都太新/数量不够）时原样返回', () => {
  const entries = [digest(1), digest(2)];
  const r = planCompaction(entries, { now: NOW });
  assert.equal(r.compacted, 0);
  assert.equal(r.summary, null);
  assert.equal(r.entries.length, 2);
});

test('planCompaction：永远保留最近 keepRecent 条 digest 原文', () => {
  const entries = Array.from({ length: 30 }, (_, i) => digest(10, `旧摘要${i}`));
  const r = planCompaction(entries, { now: NOW, keepRecent: 20, afterDays: 3 });
  const left = r.entries.filter((e) => e.kind === 'group-digest');
  assert.equal(left.length, 20, '最近 20 条不能被压');
  assert.equal(r.compacted, 10);
});

test('planCompaction：压成一条 group-compact，带时间跨度与条数', () => {
  const entries = [digest(30, '很久以前'), digest(20, '中间'), digest(10, '近一点'), ...Array.from({ length: 20 }, () => digest(1))];
  const r = planCompaction(entries, { now: NOW, keepRecent: 20, afterDays: 3 });
  assert.equal(r.compacted, 3);
  assert.equal(r.summary.kind, 'group-compact');
  assert.ok(r.summary.text.startsWith('【压缩】3 条群聊摘要'));
  assert.ok(r.summary.text.includes('很久以前'));
  assert.equal(r.summary.compactedFrom, 3);
  assert.equal(r.entries.filter((e) => e.kind === 'group-compact').length, 1);
  assert.equal(r.entries.filter((e) => e.kind === 'group-digest').length, 20, '只剩被保留的最近 20 条');
});

test('planCompaction：只动 group-digest，事实/事件/浏览记录不碰', () => {
  const entries = [
    { kind: 'fact', text: '他喜欢猫', time: '2026-01-01 10:00' },
    { kind: 'event', text: '我做了什么', time: '2026-01-01 10:00' },
    { kind: 'browse', text: '逛了什么', time: '2026-01-01 10:00' },
    ...Array.from({ length: 25 }, (_, i) => digest(10, `旧摘要${i}`)),
  ];
  const r = planCompaction(entries, { now: NOW, keepRecent: 20, afterDays: 3 });
  assert.ok(r.entries.some((e) => e.kind === 'fact'));
  assert.ok(r.entries.some((e) => e.kind === 'event'));
  assert.ok(r.entries.some((e) => e.kind === 'browse'));
  assert.equal(r.compacted, 5);
});

test('planCompaction：摘要正文截断到 maxChars；抽样最多 8 条', () => {
  const entries = Array.from({ length: 100 }, (_, i) => digest(10, `${'长'.repeat(200)}${i}`));
  const r = planCompaction(entries, { now: NOW, keepRecent: 1, afterDays: 3, maxChars: 120 });
  assert.ok(r.summary.text.length <= 120 + 40, `实际 ${r.summary.text.length}`);
  const body = r.summary.text.split('：').slice(1).join('：');
  assert.ok((body.match(/长/g) || []).length >= 8, '至少有抽样内容');
});

test('planCompaction：时间解析不出的 digest 不会被压（无从判断是否过期）', () => {
  const entries = [{ kind: 'group-digest', text: '没有时间' }, digest(10, '老的')];
  const r = planCompaction(entries, { now: NOW, keepRecent: 1, afterDays: 3 });
  assert.equal(r.compacted, 0, '唯一候选是没时间的，不压');
});

test('planCompaction：参数夹取（afterDays>=0、keepRecent>=1、maxChars>=80）', () => {
  const entries = Array.from({ length: 30 }, (_, i) => digest(10, `旧${i}`));
  const r = planCompaction(entries, { now: NOW, keepRecent: 0, afterDays: -5, maxChars: 1 });
  assert.ok(r.compacted > 0, 'keepRecent 被夹到 1');
  assert.ok(r.summary.text.length <= 80 + 40, '正文被夹到 80（head 另算）');
  assert.equal(DEFAULTS.keepRecent, 20);
});

test('splitFactsForCap：事实未超上限时原样保留', () => {
  const entries = [{ kind: 'fact', text: 'a', time: '2026-01-01' }];
  const r = splitFactsForCap(entries, { maxFacts: 10 });
  assert.equal(r.overflow.length, 0);
  assert.equal(r.keep.length, 1);
});

test('splitFactsForCap：超限时最旧的事实进 overflow，其余（含非事实）留在 keep', () => {
  const entries = [
    { kind: 'fact', text: '老1', time: '2026-01-01 10:00' },
    { kind: 'fact', text: '老2', time: '2026-01-02 10:00' },
    { kind: 'group-fact', text: '新1', time: '2026-03-01 10:00' },
    { kind: 'event', text: '事件不参与', time: '2025-01-01 10:00' },
  ];
  const r = splitFactsForCap(entries, { maxFacts: 2 });
  assert.deepEqual(r.overflow.map((e) => e.text), ['老1']);
  assert.deepEqual(r.keep.map((e) => e.text), ['老2', '新1', '事件不参与']);
});

test('splitFactsForCap：时间解析不出的当最新保留（宁可不搬走）', () => {
  const entries = [
    { kind: 'fact', text: '没时间' },
    { kind: 'fact', text: '老', time: '2026-01-01' },
    { kind: 'fact', text: '新', time: '2026-03-01' },
  ];
  const r = splitFactsForCap(entries, { maxFacts: 2 });
  assert.equal(r.overflow.length, 1);
  assert.equal(r.overflow[0].text, '老');
  assert.ok(r.keep.some((e) => e.text === '没时间'));
});

test('parseEntries / serializeEntries：往返一致，坏行跳过', () => {
  const entries = [{ a: 1 }, { b: 2 }];
  const text = serializeEntries(entries);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseEntries(text), entries);
  assert.deepEqual(parseEntries('{"a":1}\n坏行\n'), [{ a: 1 }]);
  assert.deepEqual(parseEntries([]), []);
  assert.equal(serializeEntries([]), '\n');
});
