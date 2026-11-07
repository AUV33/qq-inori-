// [QUOTE-CONTEXT] 有人引用她那条 → 把她发那条之前的群消息递回去（纯函数渲染）
//
// 判据：引用的是她、能找到她原话、前面有人说话 → 出块；否则空串（不制造暗示）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotedTextOf, buildQuoteContext } from '../src/domain/leaves/inori-quote-context.mjs';

const self = (text, seq) => ({ isSelf: true, sender: '我', text, seq });
const other = (sender, text, seq, extra = {}) => ({ isSelf: false, sender, text, seq, ...extra });

test('quotedTextOf：从引用段里取出原文', () => {
  assert.equal(quotedTextOf('[引用 小满：那你就别叫。]@小满 你这一句回的是哪'), '那你就别叫。');
  assert.equal(quotedTextOf('没有引用'), '');
});

test('引用她那条 → 递回她发那条之前的几条群消息', () => {
  const messages = [
    other('群友甲', '被摸到规律了，一叫就冒头，跟打地鼠似的', 404),
    other('群友甲', '我怎么感觉是上下文重复输入输出的问题', 405),
    self('那你就别叫。', undefined),
    other('群友甲', '[引用 小满：那你就别叫。]@小满 你这一句回的是哪', 410, { quoteTargetIsSelf: true }),
  ];
  const block = buildQuoteContext(messages);
  assert.ok(block.includes('有人引用了你那条「那你就别叫。」'), block);
  assert.ok(block.includes('seq404'), block);
  assert.ok(block.includes('seq405'), block);
  assert.ok(block.includes('别硬编'), '要给她「记不清就问」的许可');
});

test('没引用 / 引用的是别人 / 找不到她原话 → 不出块', () => {
  assert.equal(buildQuoteContext([other('群友甲', '随便说说', 1)]), '');
  assert.equal(buildQuoteContext([
    other('群友甲', '[引用 别人：xx]你说的对', 2, { quoteTargetIsSelf: false }),
  ]), '');
  assert.equal(buildQuoteContext([
    other('群友甲', '[引用 小满：一条她没发过的话]?', 3, { quoteTargetIsSelf: true }),
  ]), '');
});

test('前文最多 3 条，且不含她自己说的', () => {
  const messages = [
    other('A', '一', 1), other('B', '二', 2), other('C', '三', 3),
    other('D', '四', 4), self('好', 5), self('收到', 6),
    other('E', '[引用 小满：收到]?', 7, { quoteTargetIsSelf: true }),
  ];
  const block = buildQuoteContext(messages);
  const lines = block.split('\n').filter((l) => l.startsWith('seq'));
  assert.equal(lines.length, 3, block);
  assert.ok(!lines.some((l) => l.includes('我')), '不该把她的发言当前文');
});

test('引用太旧（超过 10 分钟）不再占位，避免每次唤醒重贴同一段前文', () => {
  const now = Date.parse('2026-10-30T18:50:00+08:00');
  const messages = [
    other('群友甲', '被摸到规律了，一叫就冒头', 404, { time: now - 20 * 60000 }),
    self('那你就别叫。'),
    other('群友甲', '[引用 小满：那你就别叫。]你这一句回的是哪', 410, { quoteTargetIsSelf: true, time: now - 11 * 60000 }),
  ];
  assert.equal(buildQuoteContext(messages, { now }), '', '旧引用应跳过');
  const fresh = messages.map((m) => ({ ...m, time: m.time ? now - 60_000 : m.time }));
  assert.notEqual(buildQuoteContext(fresh, { now }), '', '新引用仍应出块');
});

test('引用的是她发的表情/图片：也能回推前文（不再无据可查）', () => {
  const now = Date.parse('2026-10-30T21:20:00+08:00');
  const messages = [
    other('群友戊', '这两个明明是同一个画风', 10, { time: now - 120000 }),
    self('[表情]'),
    other('群友丁', '[引用 小满：[表情]]这个是你画的？', 11, { quoteTargetIsSelf: true, time: now - 60000 }),
  ];
  const block = buildQuoteContext(messages, { now });
  assert.ok(block.includes('有人引用了你那条「[表情]」'), block);
  assert.ok(block.includes('同一个画风'), block);
});
