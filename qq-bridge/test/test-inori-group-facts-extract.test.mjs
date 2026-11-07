// inori-group-facts 金标：群话题萃取（词表内、去停用、去跨词边界碎屑、长词优先）与 LLM 事实解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTopics, renderGroupTopics, parseFactsJson } from '../src/domain/leaves/inori-group-facts.js';

test('extractTopics：词表内的重复话题能抽出来', () => {
  const topics = extractTopics([
    '群里在聊：显卡 显卡 好贵',
    '群里在聊：显卡 什么时候降价',
    '群里在聊：原神 新版本',
    '群里在聊：原神 抽卡',
  ], { minDf: 2, limit: 5 });
  assert.ok(topics.includes('显卡'), JSON.stringify(topics));
  // 词表（jieba 词典）里有的真实词才会被留下
  assert.ok(topics.length >= 1);
});

test('extractTopics：只出现一次的不算（minDf 门槛）', () => {
  assert.deepEqual(extractTopics(['群里在聊：显卡 好贵'], { minDf: 2 }), []);
});

test('extractTopics：停用词与纯语气词被排除', () => {
  const topics = extractTopics(['哈哈哈哈 我们 这个 然后', '哈哈哈哈 我们 这个 然后'], { minDf: 2 });
  assert.deepEqual(topics, []);
});

test('extractTopics：跨词边界拼出来的碎屑被挡掉（含停用字/非词表）', () => {
  // 全是生僻字拼的串：词表里没有，也不成词
  assert.deepEqual(extractTopics(['曌龘靐齉 曌龘靐齉', '曌龘靐齉 曌龘靐齉'], { minDf: 2 }), []);
  // 含停用字的 n-gram 被挡（「的了是我」这类）
  assert.deepEqual(extractTopics(['的了是我你 的了是我你'], { minDf: 2 }), []);
  // 而词表里的真词保留
  assert.ok(extractTopics(['显卡 显卡', '显卡 又涨'], { minDf: 2 }).includes('显卡'));
});

test('extractTopics：同一条摘要里重复只算一次', () => {
  assert.deepEqual(extractTopics(['显卡 显卡 显卡 显卡'], { minDf: 2 }), [], '只有一条摘要');
});

test('extractTopics：空输入/非数组安全；limit 生效', () => {
  assert.deepEqual(extractTopics([]), []);
  assert.deepEqual(extractTopics(null), []);
  const many = [];
  for (const w of ['显卡', '原神', '键盘', '耳机', '显示器']) {
    many.push(`群里在聊：${w} 好`, `群里在聊：${w} 贵`);
  }
  assert.ok(extractTopics(many, { minDf: 2, limit: 2 }).length <= 2);
});

test('renderGroupTopics：至少 min 个话题才成句，否则空串', () => {
  assert.equal(renderGroupTopics(['显卡', '原神']), '', '默认 min=3');
  assert.equal(renderGroupTopics(['显卡', '原神', '键盘']), '近 24h 群里常聊：显卡、原神、键盘');
  assert.equal(renderGroupTopics([]), '');
  assert.equal(renderGroupTopics(null), '');
  assert.equal(renderGroupTopics(['显卡', '原神'], { min: 2 }), '近 24h 群里常聊：显卡、原神');
});

test('parseFactsJson：只认字符串数组，长度 6~100，去重且受 max 限制', () => {
  const payload = '说明如下：' + JSON.stringify(['他买了新键盘', '她要去旅行了呀', '太短', 'x'.repeat(120), '他买了新键盘']);
  const ok = parseFactsJson(payload, { max: 5 });
  assert.deepEqual(ok, ['他买了新键盘', '她要去旅行了呀'], '太短/太长/重复都过滤');

  assert.deepEqual(parseFactsJson('["一","二"]'), [], '都太短');
  assert.deepEqual(parseFactsJson('[]'), []);
  assert.deepEqual(parseFactsJson('没有数组'), []);
  assert.deepEqual(parseFactsJson('[1,2,3]'), [], '非字符串元素');
  assert.deepEqual(parseFactsJson('坏 JSON [', {}), []);
});

test('parseFactsJson：max 生效且默认 5', () => {
  const arr = Array.from({ length: 9 }, (_, i) => `事实编号第${i}条内容`);
  assert.equal(parseFactsJson(JSON.stringify(arr)).length, 5);
  assert.equal(parseFactsJson(JSON.stringify(arr), { max: 2 }).length, 2);
});
