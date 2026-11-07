// [A1] 日程卡：她自己定，不是系统抽的 —— 校验/取当前/渲染的回归锁。
//
// 要钉住的核心：没有安排就明说没有，绝不编造"她今天在做某事"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePlan, currentItem, isTodayPlan, renderDayPlanBlock, dayKeyOf, minutesOf, MAX_ITEMS,
} from '../src/domain/leaves/inori-dayplan.mjs';

const at = (h, m = 0) => new Date(2026, 9, 28, h, m, 0); // 2026-10-28 本地

test('HH:mm 解析：合法/非法', () => {
  assert.equal(minutesOf('09:30'), 570);
  assert.equal(minutesOf('9:5'), null);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf(''), null);
  assert.equal(minutesOf(undefined), null);
});

test('规范化：丢掉非法条目、按时间排序、最多 6 条', () => {
  const plan = normalizePlan({
    date: '2026-10-28',
    items: [
      { at: '15:00', what: '看视频' },
      { at: '99:99', what: '非法时间' },
      { what: '没有时间' },
      { at: '09:00', what: '写代码', mood: '投入', detail: '卡在登录' },
      { at: '11:00', what: '看视频' },
      { at: '12:00', what: '吃饭' },
      { at: '13:00', what: '午睡' },
      { at: '14:00', what: '翻帖子' },
      { at: '16:00', what: '整理图库' },
    ],
  }, { now: at(10) });
  assert.equal(plan.items.length, MAX_ITEMS);
  assert.deepEqual(plan.items.map((i) => i.at), ['09:00', '11:00', '12:00', '13:00', '14:00', '15:00']);
  assert.equal(plan.items[0].detail, '卡在登录');
});

test('她没有定 → 不是今天的计划，渲染层明说「还没定」且不提任何具体事', () => {
  const empty = normalizePlan({}, { now: at(10) });
  assert.equal(isTodayPlan(empty, at(10)), false);
  const block = renderDayPlanBlock(empty, { now: at(10) });
  assert.match(block, /今天还没定/);
  assert.match(block, /别现编/);
  assert.doesNotMatch(block, /此刻你/);
});

test('昨天定的不算今天（日期对不上）', () => {
  const plan = normalizePlan({ date: '2026-10-27', items: [{ at: '09:00', what: '写代码' }] }, { now: at(10) });
  assert.equal(isTodayPlan(plan, at(10)), false);
  assert.match(renderDayPlanBlock(plan, { now: at(10) }), /今天还没定/);
});

test('取「此刻」：at <= 现在的最后一条；都比现在晚 → null', () => {
  const plan = normalizePlan({
    date: dayKeyOf(at(10)),
    items: [{ at: '09:00', what: '写代码' }, { at: '15:00', what: '看视频' }],
  }, { now: at(10) });
  assert.equal(currentItem(plan, at(10)).what, '写代码');
  assert.equal(currentItem(plan, at(16)).what, '看视频');
  assert.equal(currentItem(plan, at(8)), null);
});

test('渲染：定过就出现「你今天给自己定的」+「此刻你」，并带可提细节', () => {
  const plan = normalizePlan({
    date: dayKeyOf(at(10)),
    items: [{ at: '09:00', what: '写代码', mood: '有点烦', detail: '卡在登录页' }],
  }, { now: at(10) });
  const block = renderDayPlanBlock(plan, { now: at(10) });
  assert.match(block, /你今天给自己定的/);
  assert.match(block, /09:00 写代码（有点烦）｜可以提：卡在登录页/);
  assert.match(block, /【此刻你】.*写代码/);
});

test('完成后标记不影响「此刻」取值，但渲染里会显示', () => {
  const plan = normalizePlan({
    date: dayKeyOf(at(10)),
    items: [{ at: '09:00', what: '写代码', done: true }],
  }, { now: at(10) });
  assert.match(renderDayPlanBlock(plan, { now: at(10) }), /已经做完了/);
});
