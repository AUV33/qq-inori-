// inori-memory-views 金标：读取期去重——同文只留较新、近重复按重要度/长度择优、不跨时间窗合并。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeText, unifyEntries, textOverlap } from '../src/domain/leaves/inori-memory-views.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const at = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

test('normalizeText：去空白/标点/符号并小写', () => {
  assert.equal(normalizeText(' 你好，世界！ '), '你好世界');
  assert.equal(normalizeText('ABC def'), 'abcdef');
  assert.equal(normalizeText(null), '');
});

test('unifyEntries：完全同文只留一条，且保留较新的那条', () => {
  const old = { text: '群里在聊爬山', kind: 'group-digest', time: at(5) };
  const fresh = { text: '群里在聊爬山', kind: 'group-digest', time: at(1) };
  const r = unifyEntries([old, fresh], { now: NOW });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0], fresh, '留较新的');
  assert.equal(r.merged, 1);
  assert.deepEqual(r.dropped, [old]);
});

test('unifyEntries：同重要度取更长的那条（信息更全）', () => {
  const shortOne = { text: '他喜欢猫', kind: 'fact', time: at(1) };
  const longOne = { text: '他喜欢猫，尤其是橘猫', kind: 'fact', time: at(1) };
  const r = unifyEntries([shortOne, longOne], { now: NOW });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].text, longOne.text);
});

test('unifyEntries：重要度不同取重要度高的（fact 4 > group-digest 2）', () => {
  const digest = { text: '他喜欢猫这件事', kind: 'group-digest', time: at(1) };
  const fact = { text: '他喜欢猫', kind: 'fact', time: at(1) };
  const r = unifyEntries([digest, fact], { now: NOW, threshold: 0.5 });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].kind, 'fact');
});

test('unifyEntries：近重复但超出时间窗 → 不合并', () => {
  const a = { text: '群里在聊周末去哪玩', kind: 'group-digest', time: at(30) };
  const b = { text: '群里在聊周末去哪玩了', kind: 'group-digest', time: at(1) };
  const r = unifyEntries([a, b], { now: NOW });
  assert.equal(r.entries.length, 2, '相隔 29 天不算同一视图');
});

test('unifyEntries：没有文本的条目原样保留；非数组输入安全', () => {
  const empty = { kind: 'fact', text: '   ' };
  const r = unifyEntries([empty, { text: '有内容', kind: 'fact', time: at(1) }], { now: NOW });
  assert.equal(r.entries.length, 2);
  assert.deepEqual(unifyEntries(null).entries, []);
  assert.deepEqual(unifyEntries([]).entries, []);
});

test('unifyEntries：幂等（同输入再跑一次结果不变）', () => {
  const entries = [
    { text: '同一句', kind: 'fact', time: at(1) },
    { text: '同一句', kind: 'fact', time: at(2) },
    { text: '另一句完全不同的内容', kind: 'event', time: at(1) },
  ];
  const once = unifyEntries(entries, { now: NOW });
  const twice = unifyEntries(once.entries, { now: NOW });
  assert.equal(twice.entries.length, once.entries.length);
  assert.equal(twice.merged, 0);
});

test('importanceOf（间接）：显式 importance 优先且夹在 1..5', () => {
  const a = { text: '这句话比较长一些', kind: 'event', importance: 5, time: at(1) };
  const b = { text: '这句话比较长一些', kind: 'fact', importance: 1, time: at(1) };
  const r = unifyEntries([b, a], { now: NOW });
  assert.equal(r.entries[0], a, '显式 importance=5 的胜出');
});

test('textOverlap：二元组重叠率（给阈值调参用）', () => {
  assert.equal(textOverlap('abcd', 'abcd'), 1);
  assert.equal(textOverlap('abcd', 'wxyz'), 0);
  assert.ok(textOverlap('今天天气很好', '今天天气不错') > 0.5);
  assert.equal(textOverlap('', 'x'), 0);
});

test('DEFAULTS：7 天窗口 + 0.85 阈值', () => {
  assert.equal(DEFAULTS.windowMs, 7 * 24 * 3600 * 1000);
  assert.equal(DEFAULTS.threshold, 0.85);
});
