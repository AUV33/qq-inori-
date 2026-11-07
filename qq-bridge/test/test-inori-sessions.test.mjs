import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConversations, relativeTime } from '../src/domain/leaves/inori-sessions.js';

const NOW = Date.parse('2026-10-27T19:30:00+08:00');
const min = (n) => NOW - n * 60000;

test('relativeTime：粗粒度人话', () => {
  assert.equal(relativeTime(min(0), NOW), '刚刚');
  assert.equal(relativeTime(min(5), NOW), '5 分钟前');
  assert.equal(relativeTime(min(150), NOW), '2 小时前');
  assert.equal(relativeTime(min(60 * 50), NOW), '2 天前');
  assert.equal(relativeTime(0, NOW), '');
});

test('renderConversations：当前会话排第一并标出来', () => {
  const out = renderConversations(
    [
      { key: 'group:123456789', lastIncomingAt: min(30), unread: [{}, {}] },
      { key: 'private:10001', lastIncomingAt: min(2), lastAiReplyAt: min(1) },
    ],
    { currentKey: 'group:123456789', now: NOW },
  );
  const lines = out.split('\n');
  assert.match(out, /【你手头的会话】/);
  assert.match(lines[1], /群 123456789 · 当前这个/);
  assert.match(out, /私聊 10001 · 1 分钟前/);
  assert.match(out, /未读 2/);
});

test('renderConversations：别的会话按最近活跃排序', () => {
  const out = renderConversations(
    [
      { key: 'group:1', lastIncomingAt: min(90) },
      { key: 'group:2', lastIncomingAt: min(3) },
    ],
    { currentKey: 'group:9', now: NOW },
  );
  const idx2 = out.indexOf('群 2');
  const idx1 = out.indexOf('群 1');
  assert.ok(idx2 >= 0 && idx1 > idx2, out);
});

test('renderConversations：超过上限截断并说明还有几个', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ key: `group:${100 + i}`, lastIncomingAt: min(i + 1) }));
  const out = renderConversations(many, { now: NOW, max: 3 });
  assert.equal((out.match(/^- /gm) || []).length, 3);
  assert.match(out, /还有 6 个没列/);
});

test('renderConversations：空会话/无时间/坏 key 不注入', () => {
  assert.equal(renderConversations([], { now: NOW }), '');
  assert.equal(renderConversations([{ key: 'group:1' }], { now: NOW }), '');
  assert.equal(renderConversations([{ key: 'weird:1', lastIncomingAt: min(1) }], { now: NOW }), '');
});

test('renderConversations：只递事实，不包含消息内容', () => {
  const out = renderConversations(
    [{ key: 'private:10001', lastIncomingAt: min(3), recentMessages: [{ text: '这是私聊内容不该出现' }] }],
    { now: NOW },
  );
  assert.equal(out.includes('这是私聊内容不该出现'), false);
});
