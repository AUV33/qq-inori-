// test-recall-golden.mjs · 记忆召回金标准（E1 回归门禁；G7 的"无金标准/无回归门禁"）
//
// 离线跑法：注入确定性 fake embedder（bigram 余弦≈字面重合），不依赖外部模型。
// 金标准查询刻意带与目标记忆的字面重叠（"字面/人名/主题命中"路径），用来锁
// 住召回排序管线（cos + 动量 + 重要度 + 字面补分）的回归边界。语义改写召回
// 由同一 harness 在 CI 接真实 embed 时覆盖——这里不假装测模型质量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { recall } from '../src/domain/memory/memory-retrieve.js';
import { makeFakeEmbed } from './fake-embed.mjs';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gold-')); }
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

// 一份精心构造的私人核心记忆语料（真实字段形状）。
function buildCorpus(dir) {
  const file = path.join(dir, 'memory.jsonl');
  const rows = [
    { kind: 'fact', text: '主人说她下周一生日，是10月26日', time: '2026-10-20 10:00', importance: 4, recordedAt: '2026-10-20T10:00:00Z', src: 'private' },
    { kind: 'fact', text: '主人讨厌香菜，说吃起来像肥皂', time: '2026-10-21 10:00', importance: 3, recordedAt: '2026-10-21T10:00:00Z', src: 'private' },
    { kind: 'fact', text: '主人和男朋友吵架了，因为忘记纪念日', time: '2026-10-22 10:00', importance: 3, recordedAt: '2026-10-22T10:00:00Z', src: 'private', claimType: 'conflict' },
    { kind: 'fact', text: '主人最喜欢的城市是京都，想去岚山', time: '2026-10-23 10:00', importance: 2, recordedAt: '2026-10-23T10:00:00Z', src: 'private' },
    { kind: 'fact', text: '主人答应这周末陪妈妈去逛超市', time: '2026-10-24 10:00', importance: 3, recordedAt: '2026-10-24T10:00:00Z', src: 'private', claimType: 'promise' },
    { kind: 'event', text: '主人最近在学做饭，尝试了红烧肉', time: '2026-10-25 10:00', importance: 1, recordedAt: '2026-10-25T10:00:00Z', src: 'private' },
    { kind: 'fact', text: '主人的猫叫团子，是一只橘猫', time: '2026-10-26 10:00', importance: 2, recordedAt: '2026-10-26T10:00:00Z', src: 'private' },
  ];
  writeRows(file, rows);
}

// 金标准：(查询, 期望被想起的记忆原文)，查询刻意含字面重叠。
const GOLD = [
  ['生日 10月26日', '主人说她下周一生日，是10月26日'],
  ['香菜', '主人讨厌香菜，说吃起来像肥皂'],
  ['吵架 纪念日', '主人和男朋友吵架了，因为忘记纪念日'],
  ['京都 岚山', '主人最喜欢的城市是京都，想去岚山'],
  ['答应 周末 妈妈 超市', '主人答应这周末陪妈妈去逛超市'],
];

for (const [query, expected] of GOLD) {
  test(`金标准召回：${query} → 想起「${expected.slice(0, 8)}…」`, async () => {
    const dir = tmpDir();
    buildCorpus(dir);
    const r = await recall(query, { dir, scope: 'private', embed: makeFakeEmbed(), now: NOW, limit: 5, shareGroup: false, searchArchive: false, minSim: 0.15 });
    const texts = r.entries.map((e) => e.text);
    assert.ok(texts.length > 0, '应有召回结果');
    assert.ok(texts.slice(0, 3).includes(expected), `期望「${expected}」进 top3，实际: ${texts.slice(0, 3).join(' | ')}`);
  });
}

test('金标准整体：recall@3 ≥ 1.0（每条查询都精准想起，作为回归基线）', async () => {
  let hit = 0;
  for (const [query, expected] of GOLD) {
    const dir = tmpDir();
    buildCorpus(dir);
    const r = await recall(query, { dir, scope: 'private', embed: makeFakeEmbed(), now: NOW, limit: 5, shareGroup: false, searchArchive: false, minSim: 0.15 });
    if (r.entries.slice(0, 3).map((e) => e.text).includes(expected)) hit += 1;
  }
  assert.equal(hit, GOLD.length, `应全中，实际 ${hit}/${GOLD.length}`);
});
