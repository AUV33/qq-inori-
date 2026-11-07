// inori-rumination 金标：情绪反刍的来源检测、时间衰减、去重/上限/消化闭环与注入渲染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRumination, decayOf, addRumination, renderRuminations } from '../src/domain/leaves/inori-rumination.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const H = 3600000;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rum-')), 'ruminations.jsonl');
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('detectRumination：自我批评 / 被纠正 / 任务卡住 三类来源，强度不同', () => {
  assert.equal(detectRumination('其实是我想多了').source, 'self-criticism');
  assert.equal(detectRumination('其实是我想多了').intensity, 0.8);
  // 同时命中「自我批评」与「被纠正」时，按 SELF_CRITIC 优先（确定性顺序，强度更高）
  assert.equal(detectRumination('你说得对，我搞错了').source, 'self-criticism');
  assert.equal(detectRumination('被你提醒了，我重新看').source, 'corrected');
  assert.equal(detectRumination('被你提醒了，我重新看').intensity, 0.7);
  assert.equal(detectRumination('那件事卡住了').source, 'task-failed');
  assert.equal(detectRumination('那件事卡住了').intensity, 0.6);
});

test('detectRumination：普通闲聊/长段落都不算（反刍是一句话扎一下）', () => {
  assert.equal(detectRumination('今天天气不错'), null);
  assert.equal(detectRumination(''), null);
  assert.equal(detectRumination(null), null);
  assert.equal(detectRumination('其实是我多想了我'.repeat(20)), null, '超过 120 字不算');
});

test('detectRumination：core 截断 40 字', () => {
  const r = detectRumination('搞砸了' + '啊'.repeat(100));
  assert.equal(r.core.length, 40);
});

test('decayOf：≤2h 原强度、2-8h ×0.6、8-24h ×0.35、>48h 停止注入', () => {
  const row = { at: NOW - H, intensity: 0.8 };
  assert.equal(decayOf(row, NOW), 0.8);
  assert.ok(Math.abs(decayOf({ at: NOW - 5 * H, intensity: 0.8 }, NOW) - 0.48) < 1e-9);
  assert.ok(Math.abs(decayOf({ at: NOW - 12 * H, intensity: 0.8 }, NOW) - 0.28) < 1e-9);
  assert.equal(decayOf({ at: NOW - 49 * H, intensity: 0.8 }, NOW), 0);
});

test('addRumination：写盘、每天最多 4 条', () => {
  const file = tmpFile();
  for (let i = 0; i < 4; i += 1) {
    assert.ok(addRumination({ core: `第${i}件`, source: 'self-criticism' }, file, NOW + i));
  }
  assert.equal(addRumination({ core: '第五条', source: 'corrected' }, file, NOW + 10), null);
  assert.equal(readRows(file).length, 4);
});

test('addRumination：同 core 24h 内只刷新时间并重置已消化', () => {
  const file = tmpFile();
  addRumination({ core: '搞砸了汇报', source: 'self-criticism' }, file, NOW - H);
  writeRows(file, readRows(file).map((r) => ({ ...r, consumed: true })));
  const again = addRumination({ core: '搞砸了汇报', source: 'self-criticism' }, file, NOW);
  assert.equal(readRows(file).length, 1, '不新增');
  assert.equal(again.consumed, false, '重新变成未消化');
  assert.equal(again.at, NOW);
});

test('addRumination：只保留最近 100 条（防文件膨胀）', () => {
  const file = tmpFile();
  const old = Array.from({ length: 120 }, (_, i) => ({ core: `旧${i}`, at: NOW - 30 * 3600000 - i, consumed: false }));
  writeRows(file, old);
  addRumination({ core: '新的', source: 'self-criticism' }, file, NOW);
  const rows = readRows(file);
  assert.equal(rows.length, 100);
  assert.equal(rows[rows.length - 1].core, '新的');
});

test('renderRuminations：空/全部消化返回空串', () => {
  const file = tmpFile();
  assert.equal(renderRuminations(file, [], NOW), '');
  writeRows(file, [{ core: '某件事', at: NOW - H, intensity: 0.8, consumed: true }]);
  assert.equal(renderRuminations(file, [], NOW), '');
});

test('renderRuminations：只注入最近 24h、未消化、强度够的前 2 条', () => {
  const file = tmpFile();
  writeRows(file, [
    { core: '三件里最新', at: NOW - 1 * H, intensity: 0.8, consumed: false },
    { core: '次新', at: NOW - 3 * H, intensity: 0.8, consumed: false },
    { core: '太久了', at: NOW - 30 * H, intensity: 0.8, consumed: false },
    { core: '很弱', at: NOW - 20 * H, intensity: 0.1, consumed: false },
  ]);
  const text = renderRuminations(file, [], NOW);
  assert.ok(text.startsWith('【你一直在惦记的】'));
  assert.equal((text.match(/^- /gm) || []).length, 2);
  assert.ok(text.includes('三件里最新'));
  assert.ok(text.includes('最近一直在想'), '新鲜的高强度用「最近一直在想」');
  assert.ok(text.includes('别硬说'), '只给许可，不替她决定说什么');
});

test('renderRuminations：她把核心词说出口就算消化，不再注入', () => {
  const file = tmpFile();
  writeRows(file, [{ core: '搞砸了那次汇报', at: NOW - H, intensity: 0.8, consumed: false }]);
  assert.ok(renderRuminations(file, [], NOW).includes('搞砸了那次汇报'));
  const after = renderRuminations(file, ['我刚才搞砸了那次汇报，下次注意'], NOW);
  assert.equal(after, '', '说出口即消化');
});

test('renderRuminations：来源决定括号里的归因（被纠正/没做成/自己别扭）', () => {
  const file = tmpFile();
  writeRows(file, [
    { core: '被纠正的事', at: NOW - H, intensity: 0.8, source: 'corrected' },
    { core: '没做成的事', at: NOW - 2 * H, intensity: 0.8, source: 'task-failed' },
  ]);
  const text = renderRuminations(file, [], NOW);
  assert.ok(text.includes('被纠正后'));
  assert.ok(text.includes('那件事没做成'));
});
