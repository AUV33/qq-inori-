// inori-traces 金标：经验池（成功与失败都存）——落盘/读取/最近 N 条/同类失败史/失败率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, append, load, recent, priorFailures, stats } from '../src/domain/leaves/inori-traces.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-traces-'));
const day = () => new Date().toLocaleDateString('sv-SE');

test('append：写入当天文件，字段被夹取/截断', () => {
  const dir = tmpDir();
  const entry = append({
    goal: '给方舟换班',
    steps: Array.from({ length: 80 }, (_, i) => `s${i}`),
    result: 'success',
    scope: 'group:1',
    note: 'note',
  }, { dir });
  assert.equal(entry.result, 'success');
  assert.equal(entry.steps.length, 60, '步骤最多 60 条');
  assert.equal(entry.scope, 'group:1');
  assert.ok(entry.day);

  const rows = load(day(), { dir });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal, '给方舟换班');
});

test('append：result 非 success 一律记 fail（不臆造成功）', () => {
  const dir = tmpDir();
  assert.equal(append({ goal: 'x', result: 'unknown' }, { dir }).result, 'fail');
  assert.equal(append({ goal: 'y' }, { dir }).result, 'fail');
});

test('append：写不进目录时返回 null（不抛）', () => {
  const dir = path.join(tmpDir(), 'a');
  fs.writeFileSync(dir, 'not a directory');
  assert.equal(append({ goal: 'x' }, { dir: path.join(dir, 'sub') }), null);
});

test('load：坏行跳过；缺文件返回空数组', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, `${day()}.jsonl`), '{"goal":"a"}\n坏行\n{"goal":"b"}\n', 'utf8');
  assert.deepEqual(load(day(), { dir }).map((r) => r.goal), ['a', 'b']);
  assert.deepEqual(load('2000-01-01', { dir }), []);
});

test('recent：跨天回溯拼出最近 N 条（最新的在最后）', () => {
  const dir = tmpDir();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000).toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, `${yesterday}.jsonl`), '{"goal":"昨天"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, `${day()}.jsonl`), '{"goal":"今天"}\n', 'utf8');
  const rows = recent(10, { dir });
  assert.deepEqual(rows.map((r) => r.goal), ['昨天', '今天'], '更早的在前，最新的在最后');
  assert.deepEqual(recent(1, { dir }).map((r) => r.goal), ['今天']);
});

test('priorFailures：只找同类目标的失败史，字面包含匹配', () => {
  const dir = tmpDir();
  const file = path.join(dir, `${day()}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ goal: '给方舟换班', result: 'fail', error: 'adb 没连' }),
    JSON.stringify({ goal: '给方舟换班', result: 'success' }),
    JSON.stringify({ goal: '整理群记忆', result: 'fail' }),
  ].join('\n') + '\n', 'utf8');

  const hits = priorFailures('方舟', { dir });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].result, 'fail');
  assert.equal(hits[0].error, 'adb 没连');

  assert.deepEqual(priorFailures('', { dir }), []);
  assert.deepEqual(priorFailures('完全不相关', { dir }), []);
});

test('priorFailures：limit 生效（最多给 limit 条）', () => {
  const dir = tmpDir();
  const file = path.join(dir, `${day()}.jsonl`);
  const rows = Array.from({ length: 8 }, (_, i) => JSON.stringify({ goal: `方舟第${i}次`, result: 'fail' }));
  fs.writeFileSync(file, rows.join('\n') + '\n', 'utf8');
  assert.equal(priorFailures('方舟', { dir }).length, 5);
  assert.equal(priorFailures('方舟', { dir, limit: 2 }).length, 2);
});

test('stats：成功/失败与成功率；没有数据时 successRate=null', () => {
  const dir = tmpDir();
  const file = path.join(dir, `${day()}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ goal: 'a', result: 'success' }),
    JSON.stringify({ goal: 'b', result: 'success' }),
    JSON.stringify({ goal: 'c', result: 'fail' }),
  ].join('\n') + '\n', 'utf8');
  const s = stats({ dir });
  assert.deepEqual(s, { total: 3, success: 2, fail: 1, successRate: 0.667 });

  assert.deepEqual(stats({ dir: tmpDir() }), { total: 0, success: 0, fail: 0, successRate: null });
});

test('DEFAULTS：按天分目录的默认配置', () => {
  assert.ok(DEFAULTS.dir.endsWith(path.join('data', 'traces')));
  assert.equal(DEFAULTS.maxPerDay, 200);
});
