// [BEHAVIOR-LOG] 她做过的事：纯函数回归锁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseToolName, categoryOf, summarizeBehavior, renderBehaviorLogLine, behaviorDigestRow } from '../src/domain/leaves/inori-behavior-log.mjs';

const NOW = Date.parse('2026-10-28T20:00:00+08:00');
const day = 86400000;

test('工具名归一：去掉 mcp 前缀', () => {
  assert.equal(baseToolName('mcp__snowluma__qq_send_message'), 'qq_send_message');
  assert.equal(baseToolName('qq_wait_for_messages'), 'qq_wait_for_messages');
});

test('分类：说话/等消息/翻消息/学习/手机/上网', () => {
  assert.equal(categoryOf('mcp__snowluma__qq_send_message'), '说话');
  assert.equal(categoryOf('mcp__snowluma__qq_wait_for_messages'), '等消息');
  assert.equal(categoryOf('mcp__snowluma__qq_mark_read'), '翻消息');
  assert.equal(categoryOf('mcp__memory__lesson_write'), '学习');
  assert.equal(categoryOf('mcp__phone__phone_open_app'), '手机');
  assert.equal(categoryOf('mcp__web-search-safe__web_search'), '上网');
  assert.equal(categoryOf('mcp__unknown__weird_tool'), '其他');
});

test('汇总：只算 call、只算窗口、只算本会话', () => {
  const rows = [
    { type: 'call', time: '2026-10-28T19:00:00+08:00', key: 'group:1', tool: 'mcp__snowluma__qq_send_message' },
    { type: 'call', time: '2026-10-28T19:05:00+08:00', key: 'group:1', tool: 'mcp__snowluma__qq_wait_for_messages' },
    { type: 'result', time: '2026-10-28T19:06:00+08:00', key: 'group:1', tool: 'mcp__snowluma__qq_send_message' },
    { type: 'call', time: '2026-10-28T19:10:00+08:00', key: 'group:2', tool: 'mcp__snowluma__qq_send_message' },
    { type: 'call', time: '2026-10-20T19:00:00+08:00', key: 'group:1', tool: 'mcp__phone__phone_open_app' },
  ];
  const s = summarizeBehavior(rows, { key: 'group:1', days: 1, now: NOW });
  assert.equal(s.total, 2);
  assert.deepEqual(s.byCategory, { 说话: 1, 等消息: 1 });
});

test('渲染：空账本不出行；有账本含总数与分项', () => {
  assert.equal(renderBehaviorLogLine({ total: 0, days: 1, byCategory: {} }), '');
  const line = renderBehaviorLogLine({ total: 3, days: 1, byCategory: { 说话: 2, 手机: 1 } });
  assert.match(line, /3 次/);
  assert.match(line, /说话 2/);
});

test('digest：day 用本地日期、带 key 与计数', () => {
  const row = behaviorDigestRow({ total: 2, byCategory: { 说话: 2 } }, { key: 'group:1', now: NOW });
  assert.equal(row.day, '2026-10-28');
  assert.equal(row.key, 'group:1');
  assert.equal(row.total, 2);
});
