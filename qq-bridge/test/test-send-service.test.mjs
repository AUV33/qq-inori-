import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSendRate, reserveSendTimes, rollbackSendTimes, normalizeSendMessages, validateMessageBounds } from '../src/domain/send/send-service.js';

const now = 1_800_000_000_000;

test('未超限时放行，并正确计算分钟/小时计数', () => {
  const st = { sendTimes: [now - 1000, now - 61_000] };
  const r = checkSendRate(st, now, { maxPerMinute: 3, maxPerHour: 10 }, 1);
  assert.equal(r.ok, true);
  assert.equal(r.recentMinute, 1);
  assert.equal(r.recentHour, 2);
});

test('预占后立即变成超限', () => {
  const st = { sendTimes: [] };
  reserveSendTimes(st, now, 2);
  assert.deepEqual(st.sendTimes, [now, now]);
  assert.equal(checkSendRate(st, now, { maxPerMinute: 2 }, 1).ok, false);
});

test('失败只回滚未发出的条数，保留部分成功', () => {
  const st = { sendTimes: [] };
  reserveSendTimes(st, now, 3);
  rollbackSendTimes(st, now, 1);
  assert.equal(st.sendTimes.filter((t) => t === now).length, 2);
});

test('normalizeSendMessages 兼容数组、JSON 字符串、单条字符串', () => {
  assert.deepEqual(normalizeSendMessages([' a ', '', 'b']).messages, ['a', 'b']);
  assert.deepEqual(normalizeSendMessages('["a","b"]').messages, ['a', 'b']);
  assert.deepEqual(normalizeSendMessages('"你好"').messages, ['你好']);
  assert.deepEqual(normalizeSendMessages('  你好  ').messages, ['你好']);
  assert.deepEqual(normalizeSendMessages(null).messages, []);
});

test('validateMessageBounds 复现条数/字数/敏感信息三种拒绝', () => {
  assert.deepEqual(validateMessageBounds(['a'], { maxMsgs: 1, maxChars: 5 }), { ok: true });
  assert.equal(validateMessageBounds(['a', 'b'], { maxMsgs: 1 }).status, 400);
  assert.equal(validateMessageBounds(['123456'], { maxChars: 5 }).status, 400);
  assert.equal(validateMessageBounds(['x'], { sensitiveRe: /x/ }).status, 403);
  assert.equal(validateMessageBounds([], {}).status, 400);
});

test('sendTimes 最多保留 500 条', () => {
  const st = { sendTimes: Array.from({ length: 500 }, (_, i) => now - i) };
  reserveSendTimes(st, now, 3);
  assert.equal(st.sendTimes.length, 500);
});
