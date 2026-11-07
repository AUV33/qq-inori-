// inori-grouphabits 金标：只统计「群的样子」——节奏/复读/表情率/常说短语/她的参与度/活跃时段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGroupHabits, renderGroupHabits } from '../src/domain/leaves/inori-grouphabits.js';

const T0 = new Date('2026-11-02T20:00:00+08:00').getTime();
const msg = (text, sec, extra = {}) => ({ sender: 'A', text, time: T0 + sec * 1000, isSelf: false, ...extra });

test('空列表：所有指标为 0，渲染返回空串', () => {
  const h = computeGroupHabits([], { now: T0 });
  assert.equal(h.others, 0);
  assert.equal(h.avgGapSec, 0);
  assert.equal(h.repeatRate, 0);
  assert.equal(h.mediaRate, 0);
  assert.deepEqual(h.common, []);
  assert.equal(renderGroupHabits(h), '');
});

test('平均间隔：只算 >1 秒且 <10 分钟的相邻间隔', () => {
  const h = computeGroupHabits([
    msg('a', 0), msg('b', 5), msg('c', 15), // 5s、10s
    msg('d', 15 + 3600), // 1 小时，忽略
    msg('e', 15 + 3602), // 2s
  ], { now: T0 });
  assert.equal(h.avgGapSec, Math.round((5 + 10 + 2) / 3));
});

test('复读率：相邻两条别人消息归一化后相同才算', () => {
  const h = computeGroupHabits([
    msg('好耶', 0), msg('好耶！', 5), msg('别的', 10), msg('别的', 15),
  ], { now: T0 });
  assert.equal(h.repeatRate, 0.67, '两位小数（2/3）');
});

test('表情/图片率：hasMedia 或 media 数组都算', () => {
  const h = computeGroupHabits([
    msg('a', 0, { hasMedia: true }), msg('b', 5, { media: [{ kind: 'image' }] }), msg('c', 10),
    msg('d', 15),
  ], { now: T0 });
  assert.equal(h.mediaRate, 0.5);
});

test('常说短语：同一句出现 ≥3 次才进榜，按次数排序', () => {
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push(msg('加一', i * 10));
  for (let i = 0; i < 3; i += 1) rows.push(msg('同意', 100 + i * 10));
  rows.push(msg('只出现一次', 300));
  const h = computeGroupHabits(rows, { now: T0 });
  assert.deepEqual(h.common.map((c) => c.text), ['加一', '同意']);
  assert.equal(h.common[0].count, 4);
});

test('她的参与度：自己发言占比；自己的话不参与复读/表情统计', () => {
  const h = computeGroupHabits([
    msg('别人的', 0), msg('我说的', 5, { isSelf: true }), msg('我说的', 10, { isSelf: true }),
    msg('别人的', 15, { hasMedia: true }),
  ], { now: T0 });
  assert.equal(h.selfCount, 2);
  assert.equal(h.myRatio, 0.5);
  assert.equal(h.others, 2);
});

test('活跃时段：别人消息的小时分布 top2', () => {
  const early = new Date('2026-11-02T09:00:00+08:00').getTime();
  const late = new Date('2026-11-02T22:00:00+08:00').getTime();
  const h = computeGroupHabits([
    { sender: 'A', text: 'x', time: early, isSelf: false },
    { sender: 'A', text: 'y', time: early + 1000, isSelf: false },
    { sender: 'A', text: 'z', time: late, isSelf: false },
  ], { now: T0 });
  assert.deepEqual(h.activeHours, [9, 22]);
});

test('renders：只有跨过阈值才提复读/表情；始终给参与度与节奏建议', () => {
  const quiet = computeGroupHabits([msg('a', 0), msg('b', 60)], { now: T0 });
  const line = renderGroupHabits(quiet);
  assert.ok(line.startsWith('【这个群的习惯】'));
  assert.ok(!line.includes('经常复读'), '低于 15% 不提');
  assert.ok(!line.includes('爱发表情'), '低于 10% 不提');
  assert.ok(line.includes('按这个节奏来'), '给节奏建议，不抄语气');

  const loud = computeGroupHabits([
    msg('好耶', 0), msg('好耶', 60), msg('x', 120, { hasMedia: true }), msg('y', 180),
  ], { now: T0 });
  const text = renderGroupHabits(loud);
  assert.ok(text.includes('爱发表情/图（25%）'), text);
});
