// test-mcp-helpers.test.mjs · mcp-helpers.js 的直接单测（满足模块闭环矩阵的「测到」信号）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowed, unquoteJsonString, errText, apiErrorText, getOneBotConfig } from '../src/mcp-helpers.js';

test('isAllowed：deny 优先；allow 非空走白名单；空 allow 按 allowAllWhenEmpty', () => {
  assert.equal(isAllowed([], [], 'x', false), false);
  assert.equal(isAllowed([], [], 'x', true), true);
  assert.equal(isAllowed(['a', 'b'], [], 'a', false), true);
  assert.equal(isAllowed(['a', 'b'], [], 'c', true), false);
  assert.equal(isAllowed(['a'], ['a'], 'a', true), false); // deny 优先于 allowAllWhenEmpty
});

test('unquoteJsonString：剥掉模型套的一层 JSON 字符串引号', () => {
  assert.equal(unquoteJsonString('"你好"'), '你好');
  assert.equal(unquoteJsonString('你好'), '你好');
  assert.equal(unquoteJsonString(123), 123);
  assert.equal(unquoteJsonString('"a"b"'), '"a"b"'); // 非法 JSON 原样返回
});

test('errText / apiErrorText：错误归一', () => {
  assert.equal(errText(null), '未知错误');
  assert.equal(errText('boom'), 'boom');
  assert.equal(errText(new Error('e1')), 'e1');
  assert.equal(apiErrorText(null), '');
  assert.equal(apiErrorText({ message: 'm' }), 'm');
});

test('getOneBotConfig：返回 httpUrl/token 字符串（读 config.json，缺省回退默认）', () => {
  const c = getOneBotConfig();
  assert.equal(typeof c.httpUrl, 'string');
  assert.equal(typeof c.token, 'string');
  // 缺省回退：无 snowluma.httpUrl 时落到本地默认端口
  assert.ok(c.httpUrl.startsWith('http://'));
});
