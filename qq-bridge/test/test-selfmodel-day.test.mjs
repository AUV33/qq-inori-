// [SELF-MODEL-DAY] 「今天已经记过快照没」按本地日期判断 —— 回归锁。
//
// 背景 bug：bridge.js 用 String(r.at).startsWith(dayKey) 判断，at 是 UTC ISO、
// dayKey 是本地日期；本地 00:00–08:00 之间 UTC 还停在昨天 → 永远判成「今天没记过」，
// 于是每次唤醒都追加一条 self_model_snapshot（evolution.jsonl 2000 行里 1604 条）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameLocalDay } from '../src/domain/leaves/inori-selfmodel.js';

const dayKeyOf = (d) => d.toLocaleDateString('sv-SE');

test('同一个本地日：UTC 串也认得出', () => {
  const now = new Date();
  assert.equal(isSameLocalDay(now.toISOString(), dayKeyOf(now)), true);
});

test('本地凌晨 0:30 —— 这条以前会判成「不是今天」（UTC 还在昨天）', () => {
  const d = new Date();
  const early = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30, 0);
  assert.equal(isSameLocalDay(early.toISOString(), dayKeyOf(early)), true);
});

test('本地 23:30 与次日 00:30 不是同一天', () => {
  const d = new Date();
  const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30, 0);
  const next = new Date(late.getTime() + 60 * 60 * 1000);
  assert.equal(isSameLocalDay(late.toISOString(), dayKeyOf(late)), true);
  assert.equal(isSameLocalDay(late.toISOString(), dayKeyOf(next)), false);
});

test('昨天不是今天', () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 26 * 60 * 60 * 1000);
  assert.equal(isSameLocalDay(yesterday.toISOString(), dayKeyOf(now)), false);
});

test('坏值 / 空值不抛错，一律 false', () => {
  assert.equal(isSameLocalDay('not-a-date', '2026-10-28'), false);
  assert.equal(isSameLocalDay('', '2026-10-28'), false);
  assert.equal(isSameLocalDay(undefined, '2026-10-28'), false);
  assert.equal(isSameLocalDay('2026-10-28T00:05:25.295Z', ''), false);
});
