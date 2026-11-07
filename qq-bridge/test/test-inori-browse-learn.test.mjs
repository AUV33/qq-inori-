// inori-browse-learn 金标：从帖子正文确定性抽词——去 CQ 码/URL/标点、排除停用字与已知词、去碎片。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTerms } from '../src/domain/leaves/inori-browse-learn.js';

test('抽取重复出现的 2~4 字词，频次不足的不要', () => {
  const terms = extractTerms(['离谱离谱离谱', '离谱'], { minFreq: 2 });
  assert.ok(terms.includes('离谱'), `实际：${JSON.stringify(terms)}`);
  assert.ok(!terms.includes('一'), '单字不抽');
});

test('CQ 码 / URL / 标点被清掉，不参与成词', () => {
  const terms = extractTerms(['[CQ:at,qq=1] 看这个 https://example.com/x 离谱离谱离谱'], { minFreq: 2 });
  assert.ok(terms.includes('离谱'));
  assert.ok(terms.every((t) => !t.includes('http') && !t.includes('CQ')));
});

test('停用字构成的词被排除（的了是在有和就…）', () => {
  const terms = extractTerms(['我们的我们的我们的', '就是你啊就是你啊'], { minFreq: 2 });
  assert.ok(!terms.some((t) => /[的了是在有和就]/.test(t)), `实际：${JSON.stringify(terms)}`);
});

test('已知词（含互相包含）不重复抽', () => {
  const terms = extractTerms(['崩不住了崩不住了'], { minFreq: 2, known: new Set(['崩不住']) });
  assert.deepEqual(terms, [], '已知词及其包含关系都排除');
  const terms2 = extractTerms(['崩不住了崩不住了'], { minFreq: 2, known: new Set(['崩不住了呀']) });
  assert.deepEqual(terms2, [], '已知长词包含候选时也排除');
});

test('不重复抽互相包含的碎片（保留长词）', () => {
  const terms = extractTerms(['哈基米哈基米哈基米'], { minFreq: 2, maxTerms: 8 });
  assert.ok(terms.includes('哈基米'), `实际：${JSON.stringify(terms)}`);
  assert.ok(!terms.includes('哈基'), '被已选长词包含的碎片要跳过');
});

test('maxTerms / minLen / maxLen 可控', () => {
  const text = '阿巴阿巴阿巴，七八七八七八，九十九十九十';
  assert.ok(extractTerms([text], { minFreq: 2, maxTerms: 1 }).length <= 1);
  const onlyTwo = extractTerms([text], { minFreq: 2, minLen: 2, maxLen: 2 });
  assert.ok(onlyTwo.every((t) => [...t].length === 2));
});

test('空输入/纯英文/纯标点返回空数组', () => {
  assert.deepEqual(extractTerms([]), []);
  assert.deepEqual(extractTerms(['hello world only english']), []);
  assert.deepEqual(extractTerms(['！！！？？？']), []);
  assert.deepEqual(extractTerms(null), []);
  assert.deepEqual(extractTerms([123]), []);
});
