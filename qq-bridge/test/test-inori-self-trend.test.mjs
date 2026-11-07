// inori-self-trend 金标：近 N 天 vs 上一周的自我趋势——没数据返回 null，不硬造。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonlSafe, summarizeSelfTrend, renderSelfTrend } from '../src/domain/leaves/inori-self-trend.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const style = (daysAgo, over = {}) => ({
  at: at(daysAgo),
  mine: { avgLen: 10, shortRatio: 0.2 },
  gap: 5,
  verdict: 'ok',
  ...over,
});
const action = (daysAgo, over = {}) => ({ at: at(daysAgo), t: 'turn', ...over });

test('readJsonlSafe：坏行跳过；文件缺失返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trend-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, '{"a":1}\n坏行\n{"a":2}\n', 'utf8');
  assert.deepEqual(readJsonlSafe(file), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(readJsonlSafe(path.join(dir, 'nope.jsonl')), []);
});

test('summarizeSelfTrend：完全没有数据时 hasData=false', () => {
  const s = summarizeSelfTrend({ now: NOW });
  assert.equal(s.hasData, false);
  assert.equal(s.current.style, null);
  assert.equal(s.current.lessons, 0);
});

test('summarizeSelfTrend：按 7 天窗口切当前/上一周，分别算说话字数与短句占比均值', () => {
  const s = summarizeSelfTrend({
    now: NOW,
    styleRows: [
      style(1, { mine: { avgLen: 12, shortRatio: 0.3 } }),
      style(2, { mine: { avgLen: 8, shortRatio: 0.1 } }),
      style(9, { mine: { avgLen: 20, shortRatio: 0.6 } }),
    ],
  });
  assert.equal(s.hasData, true);
  assert.equal(s.current.style.avgLen, 10);
  assert.equal(Number(s.current.style.shortRatio.toFixed(2)), 0.2);
  assert.equal(s.previous.style.avgLen, 20);
});

test('summarizeSelfTrend：场合判定分三类计数；回合/主动/暂存分开统计', () => {
  const s = summarizeSelfTrend({
    now: NOW,
    styleRows: [style(1, { verdict: 'ok' }), style(2, { verdict: 'too_long' }), style(3, { verdict: 'too_short' })],
    actionRows: [
      action(1, { t: 'turn' }),
      action(2, { t: 'turn' }),
      action(3, { t: 'busy_stash' }),
      action(4, { t: 'wake', trigger: 'joinTopic' }),
      action(9, { t: 'turn' }),
    ],
  });
  assert.equal(s.current.style.ok, 1);
  assert.equal(s.current.style.tooLong, 1);
  assert.equal(s.current.style.tooShort, 1);
  assert.equal(s.current.action.turns, 2);
  assert.equal(s.current.action.stash, 1);
  assert.equal(s.current.action.proactive, 1);
  assert.equal(s.previous.action.turns, 1);
});

test('summarizeSelfTrend：没有时间戳的条目被忽略（不硬造趋势）', () => {
  const s = summarizeSelfTrend({ now: NOW, actionRows: [{ t: 'turn' }, { t: 'turn', at: '不是时间' }] });
  assert.equal(s.current.action.turns, 0);
  assert.equal(s.hasData, false);
});

test('summarizeSelfTrend：经验按窗口计数', () => {
  const s = summarizeSelfTrend({
    now: NOW,
    lessonsRows: [{ at: at(1) }, { at: at(2) }, { at: at(9) }],
  });
  assert.equal(s.current.lessons, 2);
  assert.equal(s.previous.lessons, 1);
});

test('renderSelfTrend：没数据返回 null；有数据时给对比句', () => {
  assert.equal(renderSelfTrend(null), null);
  assert.equal(renderSelfTrend({ hasData: false }), null);

  const s = summarizeSelfTrend({
    now: NOW,
    days: 7,
    styleRows: [style(1, { mine: { avgLen: 12, shortRatio: 0.3 } }), style(9, { mine: { avgLen: 10, shortRatio: 0.1 } })],
    actionRows: [action(1), action(9)],
    lessonsRows: [{ at: at(1) }],
  });
  const text = renderSelfTrend(s);
  assert.ok(text.startsWith('我最近（近 7 天 vs 上一周）：'));
  assert.ok(text.includes('说话字数 10.0→12.0（+2.0）'));
  assert.ok(text.includes('短句占比 10%→30%（+20）'));
  assert.ok(text.includes('新经验 +1'));
});

test('renderSelfTrend：只有当前数据时只说现状，不做无意义的对比', () => {
  const s = summarizeSelfTrend({ now: NOW, styleRows: [style(1)] });
  const text = renderSelfTrend(s);
  assert.ok(text.includes('说话字数 10.0'));
  assert.ok(!text.includes('→'), '没有上一周数据就不写箭头');
});

test('renderSelfTrend：负数变化也要带符号（变短要说清楚）', () => {
  const s = summarizeSelfTrend({
    now: NOW,
    styleRows: [style(1, { mine: { avgLen: 5, shortRatio: 0.1 } }), style(9, { mine: { avgLen: 10, shortRatio: 0.3 } })],
  });
  const text = renderSelfTrend(s);
  assert.ok(text.includes('（-5.0）'));
  assert.ok(text.includes('（-20）'));
});
