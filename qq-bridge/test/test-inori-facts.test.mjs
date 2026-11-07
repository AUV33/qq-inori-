// inori-facts 金标：从主人私聊里确定性提事实——只转写不发挥、误捕拦截、脱敏硬保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, similarity, dedupeFacts, sanitizeFact } from '../src/domain/leaves/inori-facts.js';

const kinds = (text) => extractFacts(text).map((f) => f.kind);
const first = (text) => extractFacts(text)[0];

test('生日/年龄：转写成「他的生日是…」「他今年 N 岁」', () => {
  assert.deepEqual(kinds('我的生日是 7 月 12 日'), ['birthday']);
  assert.ok(first('我的生日是 7 月 12 日').text.includes('7 月 12 日'));
  assert.ok(first('我今年 28 岁').text.includes('他今年 28 岁'));
});

test('喜好/讨厌/习惯/住处/称谓/关系/雷区', () => {
  assert.ok(first('我很喜欢《明日方舟》').text.includes('他喜欢「《明日方舟》」'));
  assert.ok(first('我特别讨厌香菜').text.includes('他讨厌「香菜」'));
  assert.ok(first('我每天都喝咖啡').text.includes('他习惯「'));
  assert.ok(first('我住在杭州').text.includes('他住在/在「杭州」'));
  assert.ok(first('叫我阿水就行').text.includes('可以叫他「阿水'));
  assert.ok(first('我老婆是护士').kind === 'relation');
  assert.ok(first('别跟我提加班').text.includes('别提「加班」'));
});

test('扩充类：工具/拥有/忌口/打算/在做什么/爱好', () => {
  assert.ok(first('我平时用 Mac').kind === 'tool');
  assert.ok(first('我养了一只猫').kind === 'possess');
  assert.ok(first('我不吃辣').text.includes('他不吃辣'));
  assert.ok(first('我打算学吉他').kind === 'wish');
  assert.ok(first('我在加班').kind === 'doing');
  assert.ok(first('我的爱好是摄影').kind === 'hobby');
});

test('误捕拦截：「我有空了再回」这类日常用语不是事实', () => {
  assert.deepEqual(extractFacts('我有空了再回你'), []);
  assert.deepEqual(extractFacts('我有事'), []);
  assert.deepEqual(extractFacts('我有点钱'), []);
});

test('停用值被过滤；表情占位符被剥掉；超长文本不抽', () => {
  assert.deepEqual(extractFacts('我喜欢什么'), [], '「什么」在停用表');
  assert.deepEqual(extractFacts('我喜欢[表情]'), []);
  assert.deepEqual(extractFacts('我'.repeat(300)), [], '超过 200 字不抽');
  assert.deepEqual(extractFacts(''), []);
});

test('同一句里的同类事实只留一条；evidence 保留原句片段', () => {
  const facts = extractFacts('我喜欢猫，也喜欢狗');
  assert.equal(facts.filter((f) => f.kind === 'like').length, 1, '每个 pattern 只取第一个匹配');
  assert.ok(facts[0].evidence.includes('喜欢猫'));
});

test('similarity：二元组相似度（去重判重的基础）', () => {
  assert.equal(similarity('他喜欢猫', '他喜欢猫'), 1);
  assert.ok(similarity('他喜欢猫', '他喜欢猫咪') > 0.6);
  assert.ok(similarity('他喜欢猫', '今天天气不错') < 0.3);
  assert.equal(similarity('', 'x'), 0);
});

test('dedupeFacts：和已有事实、以及候选之间都按阈值去重', () => {
  const candidates = [
    { text: '他喜欢「猫」' },
    { text: '他喜欢「猫咪」' },
    { text: '他住在杭州' },
  ];
  const kept = dedupeFacts(candidates, ['他喜欢「猫」']);
  assert.equal(kept.length, 1, '第一条与已有重复、第二条与第一条重复');
  assert.equal(kept[0].text, '他住在杭州');
  assert.equal(dedupeFacts([], []).length, 0);
});

test('sanitizeFact：手机号/账号/密码必须脱敏（硬保护）', () => {
  assert.equal(sanitizeFact('我的号码 13812345678'), '我的号码 [号码]');
  assert.ok(!sanitizeFact('账号：123456789').includes('123456789'));
  assert.ok(sanitizeFact('账号：123456789').includes('账号[已隐藏]'));
  assert.ok(!sanitizeFact('密码是 abcdef12').includes('abcdef12'));
  assert.ok(sanitizeFact('密码是 abcdef12').includes('[已隐藏]'));
  assert.equal(sanitizeFact('今天吃了面'), '今天吃了面', '普通文本不动');
});
