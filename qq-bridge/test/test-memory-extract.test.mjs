import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldExtract, buildExtractPrompt, parseFactArray, dedupeCandidates, extractFacts, DEFAULT_EXTRACT,
} from '../src/domain/leaves/inori-memory-extract.js';

const NOW = 1_800_000_000_000;

test('shouldExtract：条数不够不跑、间隔不够不跑、到点就跑', () => {
  assert.equal(shouldExtract({ now: NOW, pendingCount: 3, minMessages: 6 }), false);
  assert.equal(shouldExtract({ now: NOW, pendingCount: 8, lastAt: NOW - 5 * 60000, minGapMs: 30 * 60000 }), false);
  assert.equal(shouldExtract({ now: NOW, pendingCount: 8, lastAt: NOW - 31 * 60000, minGapMs: 30 * 60000 }), true);
  assert.equal(shouldExtract({ now: NOW, pendingCount: 8, lastAt: 0, minGapMs: 30 * 60000 }), true);
});

test('buildExtractPrompt：带上谁说的、限制条数与字数、明确只输出 JSON 数组', () => {
  const prompt = buildExtractPrompt([
    { text: '下周一我要去看牙', isSelf: false, who: '主人' },
    { text: '好', isSelf: true },
  ], { max: 2, maxChars: 60 });
  assert.match(prompt, /主人：下周一我要去看牙/);
  assert.match(prompt, /我：好/);
  assert.match(prompt, /最多 2 条/);
  assert.match(prompt, /JSON 字符串数组/);
  assert.equal(buildExtractPrompt([]), '');
});

test('parseFactArray：容忍代码块与废话，过滤空/过长/重复/非字符串', () => {
  const raw = '好的，结果如下：\n```json\n["他下周一要去看牙","他下周一要去看牙","", "太短", "这是一条明显超过九十个字的长句……' + '很长'.repeat(60) + '", 42]\n```';
  const facts = parseFactArray(raw, { max: 5, maxChars: 90 });
  assert.deepEqual(facts, ['他下周一要去看牙']);
  assert.deepEqual(parseFactArray('没有可提取的 []'), []);
  assert.deepEqual(parseFactArray('不是JSON'), []);
});

test('dedupeCandidates：和现有记忆过于相似的不重复写', () => {
  const existing = ['他下周一要去看牙', '她不喜欢香菜'];
  const out = dedupeCandidates(['他下周一要去看牙', '她不喜欢香菜（真的）', '他养了一只叫团子的猫'], existing);
  assert.deepEqual(out, ['他养了一只叫团子的猫']);
});

test('extractFacts：模型没给结果时返回空数组，不编造', async () => {
  const out = await extractFacts({ messages: [{ text: '下周一我要去看牙' }], complete: async () => null });
  assert.deepEqual(out.facts, []);
  assert.ok(out.prompt.includes('下周一我要去看牙'));
});

test('extractFacts：正常输出经解析与去重后返回', async () => {
  const out = await extractFacts({
    messages: [{ text: '下周一要去看牙，顺便把车洗了' }],
    existingTexts: ['他下周一要去看牙'],
    complete: async () => '["他下周一要去看牙","他周末打算洗车"]',
  });
  assert.deepEqual(out.facts, ['他周末打算洗车']);
});

test('默认参数：门槛保守（间隔 30 分钟、至少 6 条、最多 3 条）', () => {
  assert.equal(DEFAULT_EXTRACT.minGapMs, 30 * 60 * 1000);
  assert.equal(DEFAULT_EXTRACT.minMessages, 6);
  assert.equal(DEFAULT_EXTRACT.maxFacts, 3);
});
