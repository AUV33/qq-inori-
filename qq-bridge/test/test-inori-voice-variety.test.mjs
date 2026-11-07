// inori-voice-variety 金标：只看她自己的最近发言，找「开头/长度」重复，样本不足不提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVoice, renderVoiceVarietyHint } from '../src/domain/leaves/inori-voice-variety.js';

test('analyzeVoice：统计条数、最常见开头、长度分布、最后一条长度', () => {
  const a = analyzeVoice(['好的呀', '好耶', '好的吧', '嗯嗯', '走啦']);
  assert.equal(a.count, 5);
  assert.deepEqual(a.topOpen, { text: '好的', n: 2 });
  assert.equal(a.topBucket.bucket, 'short');
  assert.equal(a.lastLen, [...'走啦'].length);
});

test('analyzeVoice：清洗空白与开头的引号/括号，只取前两个字', () => {
  const a = analyzeVoice(['  「今天吃什么」  ', '今天好累']);
  assert.deepEqual(a.topOpen, { text: '今天', n: 2 });
});

test('analyzeVoice：只取最近 10 条；空输入安全', () => {
  const many = Array.from({ length: 15 }, (_, i) => `第${i}条`);
  assert.equal(analyzeVoice(many).count, 10);
  assert.deepEqual(analyzeVoice([]), { count: 0, topOpen: null, topBucket: null, lastLen: 0 });
  assert.deepEqual(analyzeVoice(null).count, 0);
});

test('提示：样本不足 5 条返回 null', () => {
  assert.equal(renderVoiceVarietyHint(['好的呀', '好耶']), null);
  assert.equal(renderVoiceVarietyHint([]), null);
});

test('提示：同一种开头 ≥3 条 → 提这件事（只递事实+许可）', () => {
  const texts = ['好的呀', '好的吧', '好的呢', '换一句', '再换一句'];
  const line = renderVoiceVarietyHint(texts);
  assert.ok(line.includes('你最近 5 条里有 3 条是「好的」开头'));
  assert.ok(line.includes('不想换也就这样'), '许可语气，不命令');
});

test('提示：长度分布 ≥75% 集中在同一档 → 提「大半都是…」', () => {
  const texts = ['一二三', '四五六', '七八九', '十十一', '换一个完全不同的开头啊'];
  const line = renderVoiceVarietyHint(texts);
  assert.ok(line.includes('大半都是四五字'));
});

test('提示：没有明显重复返回 null', () => {
  const texts = ['今天天气不错想出去走走', '换个开头说点别的', '再换一个完全不同的说法呀', '第四条也不一样', '第五条照样不同'];
  assert.equal(renderVoiceVarietyHint(texts), null);
});
