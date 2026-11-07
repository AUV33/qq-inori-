// test-inori-reasoning · 思考链纯逻辑：取思考 / 挑摘要 / 留全文与经验候选的门槛
import assert from 'node:assert';
import test from 'node:test';
import { reasoningTextOf, reasoningTailText, shouldKeepFull, candidateTextFrom } from '../src/domain/leaves/inori-reasoning.js';

test('reasoningTextOf：只取 reasoning 块，忽略正文与工具调用', () => {
  const ev = {
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '先想清楚她想干什么。' },
          { type: 'text', text: '（这是要说出口的话，不算思考）' },
          { type: 'tool-call', name: 'x', arguments: '{}' },
          { type: 'reasoning', text: '那就先回桌面。' },
        ],
      },
    },
  };
  const got = reasoningTextOf(ev);
  assert.equal(got, '先想清楚她想干什么。\n那就先回桌面。');
  assert.equal(reasoningTextOf({}), '');
  assert.equal(reasoningTextOf(null), '');
});

test('reasoningTailText：中文/判断句优先，不取 "Close." 这种收尾词', () => {
  const text = '看一眼界面。\n\n卡住了，先别连点三次，换个名字再找。\n\nClose.';
  const tail = reasoningTailText(text);
  assert.ok(tail.includes('先别连点三次'), `应挑出判断句，实际：${tail}`);
  assert.ok(!tail.startsWith('Close'));
});

test('reasoningTailText：太短的句子不算摘要', () => {
  assert.equal(reasoningTailText('Close.'), '');
  assert.equal(reasoningTailText(''), '');
  assert.equal(reasoningTailText('   '), '');
});

test('reasoningTailText：超长句截到 140 字以内', () => {
  const long = '这件事应该这样做：' + '很长的推理'.repeat(40) + '。';
  const tail = reasoningTailText(long);
  assert.ok([...tail].length <= 140, `实际长度 ${[...tail].length}`);
});

test('shouldKeepFull：600 字是门槛（长思考才留全文）', () => {
  assert.equal(shouldKeepFull(599), false);
  assert.equal(shouldKeepFull(600), true);
  assert.equal(shouldKeepFull(10854), true);
});

test('candidateTextFrom：只有失败回合才留经验候选，且摘要要够长', () => {
  const good = '试了两次都不对，下次先截图看清楚再点。';
  assert.equal(candidateTextFrom(good, { failed: false }), '');
  assert.ok(candidateTextFrom(good, { failed: true }).length >= 12);
  assert.equal(candidateTextFrom('Close.', { failed: true }), '');
  assert.equal(candidateTextFrom('', { failed: true }), '');
});

test('reasoningTailText：纯英文推理不当作念头（L3）', () => {
  const text = 'The instructions say every turn should end with a wake decision. I should check the queue first.';
  assert.equal(reasoningTailText(text), '');
});
