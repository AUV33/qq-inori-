// inori-style 金标：把「逗号缝成的长句」拆回多条气泡——括号内不切、太短并回、超上限整条保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, splitClauses } from '../src/domain/leaves/inori-style.js';

test('短句/没有逗号的整条不拆', () => {
  assert.deepEqual(splitClauses(['行吧']), ['行吧']);
  assert.deepEqual(splitClauses(['这是一句没有任何标点的完整话']), ['这是一句没有任何标点的完整话']);
  assert.deepEqual(splitClauses([]), []);
  assert.deepEqual(splitClauses(null), []);
});

test('长句在逗号处拆成多条', () => {
  assert.deepEqual(
    splitClauses(['今天先把这个弄完，然后再去看那个视频，最后早点睡吧']),
    ['今天先把这个弄完', '然后再去看那个视频', '最后早点睡吧'],
  );
});

test('太短的片段并回前一条（不在气泡里出现「3 字以下」的碎片）', () => {
  const out = splitClauses(['这个功能挺好用的，嗯，然后就没别的了']);
  assert.deepEqual(out, ['这个功能挺好用的，嗯', '然后就没别的了'], '「嗯」太短，缝回前一条而不是单独一条气泡');
});

test('成对括号内部的逗号不切（不能发半个括号）', () => {
  assert.deepEqual(
    splitClauses(['那个不吃显卡，吃时间，真的', '「他说，走吧」这句话别拆']),
    ['那个不吃显卡', '吃时间，真的', '「他说，走吧」这句话别拆'],
    '括号内的逗号不切；「真的」太短则缝回',
  );
});

test('未闭合的括号视为后面都不切（宁可整条发）', () => {
  assert.deepEqual(splitClauses(['他发了个「没闭合的括号，然后后面还有话']), ['他发了个「没闭合的括号，然后后面还有话']);
});

test('拆出的条数超过上限就整条保留（不做半吊子拆分）', () => {
  const text = '第一段话，第二段话，第三段话，第四段话，第五段话';
  const out = splitClauses([text]);
  assert.deepEqual(out, [text], '超过 maxBubbles=3 就不拆');
});

test('maxBubbles 可配（夹在 2..4）', () => {
  const text = '甲甲甲甲，乙乙乙乙，丙丙丙丙';
  assert.deepEqual(splitClauses([text], { maxBubbles: 3 }), ['甲甲甲甲', '乙乙乙乙', '丙丙丙丙']);
  assert.deepEqual(splitClauses([text], { maxBubbles: 9 }), ['甲甲甲甲', '乙乙乙乙', '丙丙丙丙'], '上限夹到 4，3 段仍可拆');
  assert.deepEqual(splitClauses([text], { maxBubbles: 1 }), [text], '上限夹到 2：3 段超过上限 → 整条保留不拆');
});

test('enabled=false 原样返回（复制数组，不改入参）', () => {
  const input = ['甲甲甲甲，乙乙乙乙'];
  const out = splitClauses(input, { enabled: false });
  assert.deepEqual(out, input);
  assert.notEqual(out, input, '返回新数组');
});

test('DEFAULTS 是设计值（12 字起拆 / 最多 3 条 / 3 字以下并回）', () => {
  assert.deepEqual(DEFAULTS, { minTotalChars: 12, maxBubbles: 3, minClauseChars: 3 });
});
