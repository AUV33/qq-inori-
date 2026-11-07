// [AFFECT] 少样本示例检索单测：用假 embed 验证"挑最像的、有阈值、不炸"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExamples, AFFECT_EXAMPLES } from '../src/domain/persona/affect-examples.js';

const fakeEmbed = (map) => async (texts) => texts.map((t) => {
  const v = map[t] || map.default;
  return v;
});

test('挑出与查询最像的示例', async () => {
  const embed = fakeEmbed({
    '你是不是不想理我': [1, 0],
    '你是不是嫌我烦': [0.99, 0.01],
    '你个傻蛋哈哈哈': [0, 1],
    default: [0.7, 0.7],
  });
  const got = await pickExamples('你是不是不想理我', { embed, top: 1, minSim: 0.9 });
  assert.equal(got.length, 1);
  assert.match(got[0].text, /嫌我烦/);
});

test('低于阈值的一条都不给（宁可没有示例）', async () => {
  const embed = fakeEmbed({ 'x': [1, 0], default: [0, 1] });
  const got = await pickExamples('x', { embed, top: 2, minSim: 0.99 });
  assert.equal(got.length, 0);
});

test('embed 抛错时返回空数组，不抛给调用方', async () => {
  const got = await pickExamples('x', { embed: async () => { throw new Error('boom'); } });
  assert.deepEqual(got, []);
});

test('示例库覆盖关键形态（方向/玩笑/试探）', () => {
  const texts = AFFECT_EXAMPLES.map((e) => e.text).join('|');
  assert.match(texts, /太傻逼了这个人/); // 对别人
  assert.match(texts, /傻蛋哈哈哈/);      // 玩笑
  assert.match(texts, /是不是嫌我烦/);    // 试探
  assert.ok(AFFECT_EXAMPLES.every((e) => e.affect && e.target));
});
