// [QUOTE-FIX] 单测：整条被「」包住要剥、落单引号要去、句中正常引用保留
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSelfQuoting } from '../src/domain/leaves/inori-quote-fix.js';

test('整条被「」包住 → 剥掉', () => {
  assert.equal(stripSelfQuoting('「行，那我安静会儿」'), '行，那我安静会儿');
  assert.equal(stripSelfQuoting('「风景还会自己走路了」'), '风景还会自己走路了');
});

test('整条被『』包住 → 剥掉', () => {
  assert.equal(stripSelfQuoting('『讨厌也没用』'), '讨厌也没用');
});

test('句中成对引用别人的话 → 保留', () => {
  assert.equal(stripSelfQuoting('他说「你好」就走了'), '他说「你好」就走了');
});

test('落单的左引号 → 去掉', () => {
  assert.equal(stripSelfQuoting('他说「你好 然后就走了'), '他说你好 然后就走了');
});

test('落单的右引号 → 去掉', () => {
  assert.equal(stripSelfQuoting('这什么啊」'), '这什么啊');
});

test('没有引号/空值 → 原样', () => {
  assert.equal(stripSelfQuoting('困就睡'), '困就睡');
  assert.equal(stripSelfQuoting(''), '');
  assert.equal(stripSelfQuoting(null), '');
});

test('剥完为空 → 返回空串（调用方应丢弃这条）', () => {
  assert.equal(stripSelfQuoting('「」'), '');
});
