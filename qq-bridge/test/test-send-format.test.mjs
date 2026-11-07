// send-format 金标：单行化、超长硬拆（URL 不断、emoji 不半）、空格分条、分条规划。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  singleLineForQQ, splitLongSegment, isCjkChar, splitByCjkSpaces, planSocialTimeline,
} from '../src/domain/send/send-format.mjs';

test('singleLineForQQ：换行压成空格、多空格压成一个、去首尾', () => {
  assert.equal(singleLineForQQ('  你好\n世界  \n\n  再见 '), '你好 世界 再见');
  assert.equal(singleLineForQQ(null), '');
});

test('splitLongSegment：不超长就原样一条', () => {
  assert.deepEqual(splitLongSegment('短句', 100), ['短句']);
  assert.deepEqual(splitLongSegment('   ', 100), []);
});

test('splitLongSegment：超长按标点拆，且内容不丢', () => {
  const text = '第一段内容，第二段内容；第三段内容。';
  const parts = splitLongSegment(text, 6);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text, '拆完拼回去必须一字不差');
  assert.ok(parts.every((p) => p.length <= 6 + 1));
});

test('splitLongSegment：URL 不许被拆断（这是历史事故点）', () => {
  const url = 'https://example.com/a/very/long/path?with=query&and=more';
  const text = `看这个${url}很有意思${'啊'.repeat(80)}`;
  const parts = splitLongSegment(text, 30);
  const joined = parts.join('');
  assert.ok(joined.includes(url), 'URL 必须完整出现');
  assert.ok(parts.some((p) => p.includes(url)), 'URL 必须完整落在同一条消息里（不能被拆到两段）');
  assert.equal(joined, text, '拆完拼回去一字不差');
});

test('splitLongSegment：emoji 代理对不被切半（否则两个方块）', () => {
  const text = '笑'.repeat(5) + '😀' + '哭'.repeat(50);
  const parts = splitLongSegment(text, 6);
  for (const p of parts) {
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p), `不能以低代理开头：${JSON.stringify(p)}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(p), `不能以高代理结尾：${JSON.stringify(p)}`);
  }
  assert.equal(parts.join(''), text);
});

test('isCjkChar：只认汉字，不认中文标点和全角符号', () => {
  assert.equal(isCjkChar('好'), true);
  assert.equal(isCjkChar('，'), false);
  assert.equal(isCjkChar('a'), false);
  assert.equal(isCjkChar(''), false);
});

test('splitByCjkSpaces：空格一侧是汉字就分条，两边都是 ASCII 就并回去', () => {
  assert.deepEqual(splitByCjkSpaces('你好 世界'), ['你好', '世界']);
  assert.deepEqual(splitByCjkSpaces('hello world'), ['hello world']);
  assert.deepEqual(splitByCjkSpaces('用 gpt 试试'), ['用', 'gpt', '试试']);
  assert.deepEqual(splitByCjkSpaces('   '), []);
});

test('planSocialTimeline：关闭分条只做硬拆，开启时按空格分条', () => {
  const off = planSocialTimeline('第一句 第二句', { burstEnabled: false, maxReplyChars: 500 });
  assert.deepEqual(off.main, ['第一句 第二句']);
  assert.equal(off.followUp, null);

  const on = planSocialTimeline('第一句 第二句', { burstEnabled: true, maxReplyChars: 500 });
  assert.deepEqual(on.main, ['第一句', '第二句']);

  assert.deepEqual(planSocialTimeline('', { burstEnabled: true }), { main: [], followUp: null });
  assert.deepEqual(planSocialTimeline(null, {}), { main: [], followUp: null });
});

test('planSocialTimeline：maxReplyChars 非法值回退 500', () => {
  const long = '字'.repeat(600);
  const out = planSocialTimeline(long, { burstEnabled: false, maxReplyChars: 'abc' });
  assert.ok(out.main.length >= 2, '600 字必须被拆开');
  assert.equal(out.main.join('').length, 600);
});

test('planSocialTimeline(style)：EXPR_POLICY=1 时才用 targetChars 收紧；默认忽略', () => {
  const prev = process.env.EXPR_POLICY;
  const text = '这是一句需要被硬拆的很长很长的测试句子'.repeat(12);
  const social = { maxReplyChars: 500 };
  const style = { targetChars: 40 };
  try {
    delete process.env.EXPR_POLICY;
    const old = planSocialTimeline(text, social, style);
    assert.ok(old.main.join('').length > 40, '默认不按 style 收紧');
    process.env.EXPR_POLICY = '1';
    const next = planSocialTimeline(text, social, style);
    for (const msg of next.main) assert.ok(msg.length <= 40, '单条应 <= 40: ' + msg.length);
  } finally {
    if (prev === undefined) delete process.env.EXPR_POLICY; else process.env.EXPR_POLICY = prev;
  }
});
