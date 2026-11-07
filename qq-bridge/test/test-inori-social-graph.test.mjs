// inori-social-graph 金标：他人↔他人关系图谱——名字清洗、边计数、修剪与渲染（脏名字不进提示词）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS, polarityOf, cleanName, loadSocialGraph, saveSocialGraph, noteEdge, pruneGraph, summarizeGraph, renderGraphLine, pairKey,
} from '../src/domain/leaves/inori-social-graph.js';

const NOW = 1_800_000_000_000;
const DAY = 86400000;
const emptyGraph = () => ({ groups: {} });

test('polarityOf：正/负/中性粗分', () => {
  assert.equal(polarityOf('笑死 好耶'), 'pos');
  assert.equal(polarityOf('就这 菜'), 'neg');
  assert.equal(polarityOf('今天下雨'), 'neutral');
  assert.equal(polarityOf(''), 'neutral');
});

test('cleanName：去 CQ 码/对象泄漏/控制符/零宽/组合符，截断 40 字', () => {
  assert.equal(cleanName('[CQ:at,qq=1]小明'), '小明');
  assert.equal(cleanName('[object Promise]'), '');
  assert.equal(cleanName('小\u200b明\u0000'), '小明');
  assert.equal(cleanName('e\u0301ve'), 'eve', '组合附加符被去掉');
  assert.equal(cleanName('  a   b  '), 'a b');
  assert.equal([...cleanName('长'.repeat(50))].length, 40);
});

test('noteEdge：有向计数与类型计数；自环/空名/脏名不记', () => {
  const g = emptyGraph();
  assert.equal(noteEdge(g, 'group:1', 'A', 'B', 'reply', NOW), true);
  noteEdge(g, 'group:1', 'B', 'A', 'reply', NOW);
  noteEdge(g, 'group:1', 'A', 'B', 'mention', NOW);
  const row = g.groups['group:1'].pairs[pairKey('A', 'B')];
  assert.equal(row.ab + row.ba, 3);
  assert.equal(row.reply, 2);
  assert.equal(row.mention, 1);

  assert.equal(noteEdge(g, 'group:1', 'A', 'A'), false, '自环不记');
  assert.equal(noteEdge(g, 'group:1', '', 'B'), false);
  assert.equal(noteEdge(g, 'group:1', 'A', '[object Promise]'), false, '脏名字不记');
});

test('noteEdge：极性计数只认 pos/neg', () => {
  const g = emptyGraph();
  noteEdge(g, 'k', 'A', 'B', 'reply', NOW, { polarity: 'pos' });
  noteEdge(g, 'k', 'A', 'B', 'reply', NOW, { polarity: 'neg' });
  noteEdge(g, 'k', 'A', 'B', 'reply', NOW, { polarity: 'neutral' });
  const row = g.groups.k.pairs[pairKey('A', 'B')];
  assert.equal(row.pos, 1);
  assert.equal(row.neg, 1);
});

test('pruneGraph：超过 decayDays 的边删除；超过 maxPairs 按 lastAt 留最近', () => {
  const g = emptyGraph();
  g.groups.k = { pairs: {}, updatedAt: 0 };
  g.groups.k.pairs['A|B'] = { a: 'A', b: 'B', ab: 1, ba: 0, lastAt: NOW - 50 * DAY };
  g.groups.k.pairs['A|C'] = { a: 'A', b: 'C', ab: 1, ba: 0, lastAt: NOW };
  pruneGraph(g, { now: NOW, decayDays: 45 });
  assert.deepEqual(Object.keys(g.groups.k.pairs), ['A|C']);

  const many = emptyGraph();
  many.groups.k = { pairs: {}, updatedAt: 0 };
  for (let i = 0; i < 10; i += 1) many.groups.k.pairs[`A|P${i}`] = { a: 'A', b: `P${i}`, ab: 1, ba: 0, lastAt: NOW - i * 1000 };
  pruneGraph(many, { now: NOW, maxPairs: 3 });
  assert.equal(Object.keys(many.groups.k.pairs).length, 3);
  assert.ok(many.groups.k.pairs['A|P0'], '保留最近的');
});

test('summarizeGraph：按总互动降序、只取够 minTotal 的、过滤脏名字', () => {
  const g = emptyGraph();
  for (let i = 0; i < 4; i += 1) noteEdge(g, 'k', 'A', 'B', 'reply', NOW, {});
  for (let i = 0; i < 3; i += 1) noteEdge(g, 'k', 'C', 'D', 'reply', NOW, {});
  noteEdge(g, 'k', 'E', 'F', 'reply', NOW);
  const pairs = summarizeGraph(g, 'k', { now: NOW });
  assert.deepEqual(pairs.map((p) => [p.a, p.b]), [['A', 'B'], ['C', 'D']], 'E-F 只有 1 次不够 3');
  assert.equal(pairs[0].total, 4);

  assert.deepEqual(summarizeGraph(emptyGraph(), 'k', { now: NOW }), []);
  assert.deepEqual(summarizeGraph(null, 'k'), []);
});

test('summarizeGraph：清洗后名字不一致的脏边不渲染', () => {
  const g = emptyGraph();
  g.groups.k = { pairs: {}, updatedAt: 0 };
  g.groups.k.pairs['A|B'] = { a: 'A\u0000', b: 'B', ab: 5, ba: 0, lastAt: NOW };
  assert.deepEqual(summarizeGraph(g, 'k', { now: NOW }), []);
});

test('renderGraphLine：单向强关系说「常接话」，双向说「常搭话」，并带极性/提及', () => {
  const g = emptyGraph();
  for (let i = 0; i < 5; i += 1) noteEdge(g, 'k', 'A', 'B', 'reply', NOW, { polarity: 'pos' });
  const oneWay = renderGraphLine(g, 'k', { now: NOW });
  assert.ok(oneWay.includes('A 常接 B 的话（5 次，聊得热乎）'), oneWay);

  const g2 = emptyGraph();
  for (let i = 0; i < 3; i += 1) { noteEdge(g2, 'k', 'C', 'D', 'reply', NOW); noteEdge(g2, 'k', 'D', 'C', 'reply', NOW); }
  noteEdge(g2, 'k', 'C', 'D', 'mention', NOW, { polarity: 'neg' });
  noteEdge(g2, 'k', 'C', 'D', 'mention', NOW, { polarity: 'neg' });
  const both = renderGraphLine(g2, 'k', { now: NOW });
  assert.ok(both.includes('C 和 D 常搭话'), both);
  assert.ok(both.includes('互怼多'), both);
  assert.ok(both.includes('@ 提及 2 次'), both);

  assert.equal(renderGraphLine(emptyGraph(), 'k'), null);
});

test('loadSocialGraph / saveSocialGraph：往返一致；坏文件回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-graph-'));
  const file = path.join(dir, 'social-graph.json');
  const g = emptyGraph();
  noteEdge(g, 'k', 'A', 'B', 'reply', NOW);
  assert.equal(saveSocialGraph(file, g), true);
  assert.deepEqual(loadSocialGraph(file), g);
  assert.deepEqual(loadSocialGraph(path.join(dir, 'nope.json')), { groups: {} });
  fs.writeFileSync(file, '不是 JSON', 'utf8');
  assert.deepEqual(loadSocialGraph(file), { groups: {} });
});

test('DEFAULTS：300 对 / 45 天衰减 / 至少 3 次 / 前 3 对', () => {
  assert.deepEqual(DEFAULTS, { maxPairs: 300, decayDays: 45, minTotal: 3, topN: 3 });
});
