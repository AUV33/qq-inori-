import assert from 'node:assert/strict';
import { analyzeVoice, renderVoiceVarietyHint } from '../src/domain/leaves/inori-voice-variety.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('样本不够不提示', () => {
  assert.equal(renderVoiceVarietyHint(['好', '嗯', '哈哈']), null);
});

ok('同开头连着用会提示', () => {
  const line = renderVoiceVarietyHint(['哈哈好', '哈哈这', '哈哈笑死', '差不多', '行吧']);
  assert.ok(line && line.includes('哈哈') && line.includes('开头'));
});

ok('同一长度区间连着用会提示', () => {
  const line = renderVoiceVarietyHint(['今天好累', '我去睡了', '明天再说', '先这样吧', '晚安啦']);
  assert.ok(line && line.includes('大半都是'));
});

ok('正常多样不提示', () => {
  const line = renderVoiceVarietyHint(['嗯', '今天这游戏也太卡了吧', '笑死', '晚安', '明天再说这个事']);
  assert.equal(line, null);
});

ok('analyzeVoice 统计口径', () => {
  const a = analyzeVoice(['哈哈哈', '哈哈好', '别的']);
  assert.equal(a.count, 3);
  assert.equal(a.topOpen.text, '哈哈');
  assert.equal(a.topOpen.n, 2);
});

console.log(`🎉 说话多样性测试通过（${passed} 项）`);
