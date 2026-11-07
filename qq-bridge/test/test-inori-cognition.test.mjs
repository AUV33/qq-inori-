// inori-cognition 单测：认知条目的 add 合并/筛选/渲染/落盘（从历史 memory-organize 测试里独立出来）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cog from '../src/domain/leaves/inori-cognition.js';

const NOW = new Date('2026-10-27T01:00:00Z');

test('add：同一件事（重合 ≥0.6）合并更新而不是堆新条目', () => {
  const r1 = cog.add([], { concept: '他在意我自己动手', gist: '不是结果对不对' }, NOW);
  assert.equal(r1.ok, true);
  assert.equal(r1.updated, false);
  const r2 = cog.add(r1.items, { concept: '他在意我自己动手', gist: '不是结果对不对' }, NOW);
  assert.equal(r2.updated, true, '同一条应更新');
  assert.equal(r2.items.length, 1);
  assert.equal(r2.entry.times, 2);
});

test('add：不同认知各成一条；空内容被拒', () => {
  let items = cog.add([], { concept: 'A', gist: '甲' }, NOW).items;
  items = cog.add(items, { concept: '群聊冷场先接梗', gist: '别直接问' }, NOW).items;
  assert.equal(items.length, 2);
  assert.equal(cog.add(items, {}, NOW).ok, false);
});

test('pickForQuery：相关才给，最多 3 条，无关返回空', () => {
  let items = cog.add([], { concept: '他在意我自己动手', gist: '别事事等他' }, NOW).items;
  items = cog.add(items, { concept: '群里冷场先接梗', gist: '别直接问问题' }, NOW).items;
  assert.equal(cog.pickForQuery(items, '他说希望我自己动手试试').length, 1);
  assert.equal(cog.pickForQuery(items, '今晚吃什么完全无关').length, 0);
});

test('renderLine：给出事实块（query 相关时）', () => {
  const items = cog.add([], { concept: '他在意我自己动手', gist: '别事事等他' }, NOW).items;
  const line = cog.renderLine(items, '我自己动手试试');
  assert.ok(line.includes('【你已经想明白的事】'));
  assert.ok(line.includes('他在意我自己动手'));
});

test('renderLine：query 为空时给最近 maxInject 条', () => {
  const items = cog.add([], { concept: '他在意我自己动手', gist: '别事事等他' }, NOW).items;
  const line = cog.renderLine(items, '');
  assert.ok(line.includes('他在意我自己动手'), '空 query 应回退到最近的条目');
});

test('load/save 往返（临时文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-'));
  const file = path.join(dir, 'cognition.jsonl');
  const r = cog.add([], { concept: 'X', gist: 'Y' }, NOW);
  cog.save(r.items, file);
  const back = cog.load(file);
  assert.equal(back.length, 1);
  assert.equal(back[0].concept, 'X');
  assert.equal(cog.stats(back).active, 1);
});
