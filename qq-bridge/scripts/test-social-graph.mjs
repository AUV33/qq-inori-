import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteEdge, summarizeGraph, renderGraphLine, loadSocialGraph, saveSocialGraph, pairKey } from '../src/domain/leaves/inori-social-graph.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('有向计数：A 接 B 的话记在 ab/ba 上', () => {
  const g = { groups: {} };
  noteEdge(g, 'group:1', 'A', 'B', 'reply', Date.now());
  noteEdge(g, 'group:1', 'A', 'B', 'reply', Date.now());
  noteEdge(g, 'group:1', 'B', 'A', 'reply', Date.now());
  const r = summarizeGraph(g, 'group:1', { minTotal: 1 });
  assert.equal(r[0].a, 'A');
  assert.equal(r[0].ab, 2);
  assert.equal(r[0].ba, 1);
  assert.equal(r[0].total, 3);
});

ok('自己和自己不记', () => {
  const g = { groups: {} };
  assert.equal(noteEdge(g, 'group:1', 'A', 'A'), false);
  assert.equal(summarizeGraph(g, 'group:1', { minTotal: 1 }).length, 0);
});

ok('单向强于双向 2 倍 →「常接话」措辞', () => {
  const g = { groups: {} };
  for (let i = 0; i < 5; i++) noteEdge(g, 'group:1', 'A', 'B', 'adjacent');
  const line = renderGraphLine(g, 'group:1', { minTotal: 3 });
  assert.ok(line.includes('A 常接 B 的话'));
});

ok('双向差不多 →「常搭话」措辞', () => {
  const g = { groups: {} };
  for (let i = 0; i < 3; i++) { noteEdge(g, 'group:1', 'A', 'B'); noteEdge(g, 'group:1', 'B', 'A'); }
  const line = renderGraphLine(g, 'group:1', { minTotal: 3 });
  assert.ok(line.includes('常搭话'));
});

ok('没有数据返回 null', () => {
  assert.equal(renderGraphLine({ groups: {} }, 'group:1'), null);
});

ok('落盘/读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgraph-'));
  const file = path.join(dir, 'social-graph.json');
  const g = { groups: {} };
  noteEdge(g, 'group:1', 'A', 'B');
  assert.equal(saveSocialGraph(file, g), true);
  const back = loadSocialGraph(file);
  assert.ok(back.groups['group:1']);
  assert.equal(pairKey('B', 'A'), pairKey('A', 'B'));
});

import { polarityOf } from '../src/domain/leaves/inori-social-graph.js';
ok('极性粗判：好话/坏话/中性', () => {
  assert.equal(polarityOf('哈哈哈笑死'), 'pos');
  assert.equal(polarityOf('你太笨了'), 'neg');
  assert.equal(polarityOf('今天天气不错'), 'neutral');
});

ok('互怼多的对会带「互怼多」，@ 提及计数出现', () => {
  const g = { groups: {} };
  for (let i = 0; i < 3; i++) noteEdge(g, 'group:1', 'A', 'B', 'adjacent', Date.now(), { polarity: 'neg' });
  noteEdge(g, 'group:1', 'A', 'B', 'mention');
  const line = renderGraphLine(g, 'group:1', { minTotal: 3 });
  assert.ok(line.includes('互怼多'));
  assert.ok(line.includes('@ 提及 1 次'));
});
console.log(`🎉 社交图谱测试通过（${passed} 项）`);
