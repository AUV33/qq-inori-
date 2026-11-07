// test-social-graph-identity.test.mjs · 宪章 §5.9：社交图按 personId 连边，昵称只做展示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  noteEdge, summarizeGraph, renderGraphLine,
} from '../src/domain/leaves/inori-social-graph.js';

const T = Date.UTC(2026, 10, 5, 4);
const empty = () => ({ groups: {} });

test('改名不丢边：同一 userId 换昵称仍合并到同一对，展示名取最近', () => {
  const graph = empty();
  noteEdge(graph, 'group:1', '小明', '小红', 'reply', T, { fromId: '10001', toId: '10002' });
  noteEdge(graph, 'group:1', '小明改名了', '小红', 'reply', T + 1000, { fromId: '10001', toId: '10002' });
  const pairs = summarizeGraph(graph, 'group:1', { minTotal: 1, now: T + 1000 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].total, 2, '改名后仍然接得上');
  assert.deepEqual([pairs[0].aDisplay, pairs[0].bDisplay].sort(), ['小红', '小明改名了'].sort());

  const line = renderGraphLine(graph, 'group:1', { minTotal: 1, now: T + 1000 });
  assert.match(line, /小明改名了/);
  assert.equal(/p_[0-9a-f]{12}/.test(line), false, '渲染不得输出 personId');
});

test('共昵称不误并：两个不同 userId 用同一个昵称，是两条独立的边', () => {
  const graph = empty();
  noteEdge(graph, 'group:1', '同名', '小红', 'reply', T, { fromId: '10001', toId: '10002' });
  noteEdge(graph, 'group:1', '同名', '小红', 'reply', T, { fromId: '10003', toId: '10002' });
  const pairs = summarizeGraph(graph, 'group:1', { minTotal: 1, now: T });
  assert.equal(pairs.length, 2, '不同人即使昵称相同也不能并成一条');
});

test('旧图兼容：没有 aName 的老行照旧按名字渲染', () => {
  const graph = empty();
  graph.groups['group:1'] = { pairs: { '小明|小红': { a: '小明', b: '小红', ab: 2, ba: 1, reply: 2, adjacent: 1, mention: 0, pos: 0, neg: 0, lastAt: T } }, updatedAt: T };
  const pairs = summarizeGraph(graph, 'group:1', { minTotal: 1, now: T });
  assert.equal(pairs[0].aDisplay, '小明');
  assert.match(renderGraphLine(graph, 'group:1', { minTotal: 1, now: T }), /小明 和 小红/);
});

test('隐私：图里不落 QQ 号明文，只落 personId + 展示名', () => {
  const graph = empty();
  noteEdge(graph, 'group:1', '小明', '小红', 'reply', T, { fromId: '10001', toId: '10002' });
  const raw = JSON.stringify(graph);
  assert.equal(raw.includes('10001'), false);
  assert.equal(raw.includes('10002'), false);
  assert.match(raw, /p_[0-9a-f]{12}/);
});

test('接线：message-intake 记录边时传 fromId/toId', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'src/domain/conversation/message-intake.mjs'), 'utf8');
  assert.match(src, /fromId: event\.user_id/);
  assert.match(src, /toId: quoted\.senderUserId/);
  assert.match(src, /toId: prev\.userId/);
  assert.match(src, /toId: atQq/);
});
