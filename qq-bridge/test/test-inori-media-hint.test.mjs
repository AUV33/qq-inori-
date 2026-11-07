// inori-media-hint 金标：有图才提示、空窗不造暗示、提示里带可用的工具调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageHintLine } from '../src/domain/leaves/inori-media-hint.js';

test('没有图就返回 null（不造暗示）', () => {
  assert.equal(imageHintLine([]), null);
  assert.equal(imageHintLine(null), null);
  assert.equal(imageHintLine([{ text: '纯文字' }, { text: '' }]), null);
});

test('三种「有图」的判定：hasMedia / media 数组 / [图片] 占位', () => {
  const line = imageHintLine([{ hasMedia: true, messageId: 11 }, { media: [{ kind: 'image' }] }, { text: '[图片]' }]);
  assert.ok(line.includes('3 张图'));
});

test('提示带最新那条的 messageId 与 key，可直接复制调用', () => {
  const line = imageHintLine([
    { hasMedia: true, messageId: 100, text: '[图片]' },
    { hasMedia: true, messageId: 200, text: '[图片]' },
  ], 30, { key: 'group:123456789' });
  assert.ok(line.includes('key="group:123456789"'));
  assert.ok(line.includes('messageId="200"'), '取最新那张');
});

test('没有 messageId 时给通用调用说明（不编 id）', () => {
  const line = imageHintLine([{ hasMedia: true }], 30, { key: 'private:1' });
  assert.ok(line.includes('qq_get_message_images'));
  assert.ok(!line.includes('messageId="'), '不能凭空造 id');
});

test('只统计窗口内的图（默认最近 30 条）', () => {
  const old = { hasMedia: true, messageId: 1, text: '[图片]' };
  const filler = Array.from({ length: 40 }, () => ({ text: '文字' }));
  assert.equal(imageHintLine([old, ...filler]), null, '窗口外的图不算');
  assert.ok(imageHintLine([old, ...filler], 41).includes('1 张图'));
});

test('纪律：只递事实与许可，不催不考核', () => {
  const line = imageHintLine([{ hasMedia: true, messageId: 7 }], 30, { key: 'group:1' });
  assert.ok(line.includes('得你自己看'));
  assert.ok(line.includes('看不看随你'));  assert.ok(line.includes('qq_memory_append'), '告诉她记的入口，但不命令');
});

test('脏数据：数组里混着 null/undefined/0/空串也不炸', () => {
  assert.equal(imageHintLine([null, undefined, 0, ''], 30), null);
});
