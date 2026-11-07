// [DAYPLAN-LIFE] 日程注入要跟生活状态一致：睡着了就别再说「这个点你在画画」
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, renderDayPlanBlock } from '../src/domain/leaves/inori-dayplan.mjs';

const now = new Date(2026, 9, 29, 12, 30); // 本地时间 2026-10-29 12:30
const plan = normalizePlan({
  date: '2026-10-29',
  items: [{ at: '11:00', what: '补那张画' }, { at: '15:00', what: '打会儿游戏' }],
}, { now });

test('醒着：按安排说「这个点你在…」', () => {
  const block = renderDayPlanBlock(plan, { now, lifeState: { state: 'active' } });
  assert.ok(block.includes('这个点你在补那张画'), block);
});

test('睡着：改口径，不再宣称正在做事', () => {
  const block = renderDayPlanBlock(plan, { now, lifeState: { state: 'sleep' } });
  assert.ok(block.includes('已经睡了'), block);
  assert.ok(!block.includes('这个点你在补那张画'), '睡着时不该说她在画画');
  assert.ok(block.includes('补那张画'), '但安排本身还要列出来');
});

test('不传 lifeState：回落旧行为（不崩、不误判睡着）', () => {
  const block = renderDayPlanBlock(plan, { now });
  assert.ok(block.includes('这个点你在补那张画'));
  assert.ok(!block.includes('已经睡了'));
});

test('今天没定：仍然明说没定，不编造', () => {
  const block = renderDayPlanBlock({ date: '2026-01-01', items: [] }, { now, lifeState: { state: 'sleep' } });
  assert.ok(block.includes('今天还没定'));
});
