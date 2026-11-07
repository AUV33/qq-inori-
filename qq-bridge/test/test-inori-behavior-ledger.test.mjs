// inori-behavior-ledger 金标：行为账只摆事实不评价——手机/视频/经验/查词/接事/工具调用各源独立缺失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderBehaviorLedger } from '../src/domain/leaves/inori-behavior-ledger.js';

const DAY = '2000-01-01'; // 固定一个过去的日子，避免撞上真实 action-log
const DAY2 = '2000-01-02';

function makeDirs(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ledger-'));
  const state = path.join(root, 'state');
  const traces = path.join(root, 'traces');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(traces, { recursive: true });
  const dirs = { state, traces };
  const ctx = { day: DAY, dirs: { state, traces }, now: new Date(`${DAY}T12:00:00Z`) };
  return { dirs, ctx, ...overrides };
}

const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj), 'utf8');

test('没有任何痕迹时返回空串（不硬编一行空账）', () => {
  const { ctx } = makeDirs();
  assert.equal(renderBehaviorLedger(ctx), '');
});

test('手机操作段：总数与卡住数', () => {
  const { ctx, dirs } = makeDirs();
  writeJsonl(path.join(dirs.traces, `${DAY}.jsonl`), [
    { goal: 'a', stuck: false }, { goal: 'b', stuck: true },
  ]);
  const text = renderBehaviorLedger(ctx);
  assert.ok(text.includes('手机 2 段操作（1 段卡住）'), text);
  assert.ok(text.startsWith('【今天的行为账（事实，不评价）】'));
});

test('看视频：完成数/带想法数，并给出前两条的观看进度', () => {
  const { ctx, dirs } = makeDirs();
  writeJson(path.join(dirs.state, 'video-watch.json'), {
    log: [
      { ts: `${DAY}T10:00:00Z`, title: '转场教学', watched: 300, total: 300, take: '转场好看' },
      { ts: `${DAY}T11:00:00Z`, title: '做饭视频', watched: 30, total: 600 },
      { ts: `${DAY2}T11:00:00Z`, title: '别的日子的', watched: 1, total: 1 },
    ],
  });
  const text = renderBehaviorLedger(ctx);
  assert.ok(text.includes('看视频 2 条（1/2 看完，1 条留了想法）'), text);
  assert.ok(text.includes('《转场教学》看到 5:00/5:00'), text);
  assert.ok(!text.includes('别的日子的'), '只算当天');
});

test('新经验 / 查词 / 接事 / 工具调用：各源独立计数', () => {
  const { ctx, dirs } = makeDirs();
  writeJsonl(path.join(dirs.state, 'lessons.jsonl'), [
    { at: `${DAY}T09:00:00Z`, text: '经验A' }, { at: `${DAY2}T09:00:00Z`, text: '经验B' },
  ]);
  writeJson(path.join(dirs.state, 'slang.json'), { entries: [
    { content: '绷不住', updatedAt: `${DAY}T09:00:00Z` },
    { content: '老词', updatedAt: `${DAY2}T09:00:00Z` },
  ] });
  writeJson(path.join(dirs.state, 'goals.json'), { goals: [
    { text: '整理记忆', at: `${DAY}T09:00:00Z` }, { text: '旧目标', at: `${DAY2}T09:00:00Z` },
  ] });
  writeJsonl(path.join(dirs.state, 'tool-calls.jsonl'), [
    { ts: `${DAY}T09:00:00Z`, tool: 'a' }, { ts: `${DAY}T10:00:00Z`, tool: 'b' },
  ]);

  const text = renderBehaviorLedger(ctx);
  assert.ok(text.includes('新经验 1 条'), text);
  assert.ok(text.includes('查词 1 个'), text);
  assert.ok(text.includes('事上动了 1 处'), text);
  assert.ok(text.includes('工具调用 2 次'), text);
});

test('坏文件/缺文件都不影响其它源（各源独立 try）', () => {
  const { ctx, dirs } = makeDirs();
  fs.writeFileSync(path.join(dirs.state, 'video-watch.json'), '坏 JSON', 'utf8');
  fs.writeFileSync(path.join(dirs.traces, `${DAY}.jsonl`), '坏行\n{"goal":"a","stuck":false}\n', 'utf8');
  const text = renderBehaviorLedger(ctx);
  assert.ok(text.includes('手机 1 段操作'), text);
});

test('slang.json 是裸数组也要认（历史格式兼容）', () => {
  const { ctx, dirs } = makeDirs();
  writeJson(path.join(dirs.state, 'slang.json'), [
    { content: '绷不住', updatedAt: `${DAY}T09:00:00Z` },
  ]);
  assert.ok(renderBehaviorLedger(ctx).includes('查词 1 个'));
});

test('day 参数可指定某天；默认今天', () => {
  const { ctx, dirs } = makeDirs();
  writeJsonl(path.join(dirs.traces, `${DAY2}.jsonl`), [{ goal: 'a', stuck: false }]);
  assert.ok(renderBehaviorLedger({ ...ctx, day: DAY2 }).includes('2000-01-02：手机 1 段操作'));
  // 不传 day 时用 now 的日期
  assert.ok(renderBehaviorLedger({ dirs: { state: dirs.state, traces: dirs.traces }, now: new Date(`${DAY2}T12:00:00Z`) }).includes(DAY2));
});
