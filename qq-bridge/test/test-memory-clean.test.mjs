import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMemberName, buildGroupDigest, cleanText } from '../src/domain/leaves/inori-memory-clean.js';

// 真实事故样本（2026-10-30 从 data/state/group-members.json / 群记忆里取出的原名）
const COLOR_NAMES = [
  ['\n\n\n\b&ÿÒUÐ\n \u0012\u001e示例角色\u0010', '示例角色'],
  ['\n\u000e\u0012\f示例甲\n\t\n\u0007$ÿĀ\u0011\u0010\u0010\u0000', '示例甲'],
  ['\n\u0005\n\u0003$²\n\n\n\b%ĀĀ\u0007Ð\n\u0014\u0012\u0012示例乙⁧', '示例乙'],
  ['\n\u0014\u0012\u0012示例丙\n\t\n\u0007$ÿĀB \u0010\u0000', '示例丙'],
  ['示例丁ᅠ⁧~喵⁧‭', '示例丁~喵'],
];

test('cleanMemberName：彩色昵称取可读段（保留括号），去掉控制码与配色码', () => {
  for (const [raw, want] of COLOR_NAMES) assert.equal(cleanMemberName(raw), want, JSON.stringify(raw));
});

test('cleanMemberName：正常名字原样保留（西里尔/重音/emoji/符号名不能被误伤）', () => {
  for (const name of ['гимн Грузии', 'café', '🌸🌸', '-', '？！', '管理员（ownerQQ ）']) {
    assert.equal(cleanMemberName(name), name);
  }
  assert.equal(cleanMemberName(''), '');
  assert.equal(cleanMemberName('   '), '');
});

test('群摘要：名字先清洗再截断，不会只剩乱码；正文不含控制字符', () => {
  const digest = buildGroupDigest([
    { sender: COLOR_NAMES[0][0], text: '不用这么客气', time: 1 },
    { sender: COLOR_NAMES[1][0], text: '这图给你看不懂吧', time: 2 },
    { sender: '正常群友', text: '我也来看看', time: 3 },
  ], { perLineChars: 30 });
  assert.match(digest.text, /示例角色：不用这么客气/);
  assert.match(digest.text, /示例甲：这图给你看不懂吧/);
  assert.doesNotMatch(digest.text, /&ÿÒUÐ|ÿĀ|[\u0000-\u001f]/);
  // 12 字上限仍然生效（清洗后再算），但不能把名字截成半截
  assert.doesNotMatch(digest.text, /示例角：/);
});

test('群摘要：普通名字维持旧行为（同人连续发言合并、每人最多 2 段）', () => {
  const digest = buildGroupDigest([
    { sender: '甲', text: '第一句呢', time: 1 },
    { sender: '乙', text: '我来接一句', time: 2 },
    { sender: '甲', text: '第二句呢', time: 3 },
    { sender: '乙', text: '再回一句', time: 4 },
    { sender: '甲', text: '第三句呢', time: 5 },
  ]);
  assert.equal((digest.text.match(/甲：/g) || []).length, 2);
});

test('cleanText：占位符/控制字符照旧清掉', () => {
  assert.equal(cleanText('你好[表情277]\u0007 [图片]'), '你好');
});
