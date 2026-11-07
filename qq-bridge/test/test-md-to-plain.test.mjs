// md-to-plain 金标：Markdown→QQ 纯文本、按长度切分、按码点截断（绝不切坏 emoji）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from '../src/domain/send/md-to-plain.js';

test('mdToPlain：代码块去围栏保留内容；行内代码去反引号', () => {
  assert.equal(mdToPlain('看这个：\n```js\nconst a = 1;\n```'), '看这个：\nconst a = 1;');
  assert.equal(mdToPlain('执行 `npm test` 即可'), '执行 npm test 即可');
});

test('mdToPlain：链接保留文字并把 URL 放括号；图片保留 alt 或 URL', () => {
  assert.equal(mdToPlain('[文档](https://x.com/a)'), '文档 (https://x.com/a)');
  assert.equal(mdToPlain('![截图](https://x.com/a.png)'), '截图');
  assert.equal(mdToPlain('![](https://x.com/b.png)'), 'https://x.com/b.png');
});

test('mdToPlain：粗体/斜体/删除线/下划线标记去掉，内容保留', () => {
  assert.equal(mdToPlain('**很重** *斜* ~~删~~ __下划__'), '很重 斜 删 下划');
  assert.equal(mdToPlain('***三重***'), '三重');
});

test('mdToPlain：标题符/引用符/列表符（列表换成 •）', () => {
  assert.equal(mdToPlain('## 小节'), '小节');
  assert.equal(mdToPlain('> 引用一句'), '引用一句');
  assert.equal(mdToPlain('- 一\n- 二'), '• 一\n• 二');
  assert.equal(mdToPlain('1. 甲\n2. 乙'), '1. 甲\n2. 乙');
});

test('mdToPlain：表格行去掉首尾竖线；连续空行折叠', () => {
  const out = mdToPlain('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('a | b'));
  assert.ok(!out.includes('|---'));
  assert.equal(mdToPlain('a\n\n\n\nb'), 'a\n\nb');
});

test('mdToPlain：null/空安全', () => {
  assert.equal(mdToPlain(null), '');
  assert.equal(mdToPlain(''), '');
});

test('splitForQQ：不超长原样一条；超长优先在换行处切', () => {
  assert.deepEqual(splitForQQ('短的'), ['短的']);
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10);
  const parts = splitForQQ(text, 15);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'a'.repeat(10) + '\n');
  assert.equal(parts.join(''), text);
});

test('splitForQQ：没有换行就硬切；拼回去与原文字节一致', () => {
  const text = '字'.repeat(25);
  const parts = splitForQQ(text, 10);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), text);
});

test('splitForQQ：绝不切在 emoji 代理对中间', () => {
  const text = '啊'.repeat(9) + '😀' + '呀'.repeat(9);
  for (const max of [9, 10, 11]) {
    const parts = splitForQQ(text, max);
    for (const p of parts) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(p), `以低代理开头：${JSON.stringify(p)}`);
      assert.ok(!/[\uD800-\uDBFF]$/.test(p), `以高代理结尾：${JSON.stringify(p)}`);
    }
    assert.equal(parts.join(''), text);
  }
});

test('splitForQQ：max=1 且开头是 emoji 时也要前进（不死循环）', () => {
  const parts = splitForQQ('😀😀', 1);
  assert.equal(parts.join(''), '😀😀');
  assert.ok(parts.length >= 1);
});

test('truncateText：按码点截断，不切开代理对', () => {
  assert.equal(truncateText('abcdef', 3), 'abc');
  assert.equal(truncateText('abc', 10), 'abc');
  const emoji = 'a😀b';
  const cut = truncateText(emoji, 2);
  assert.equal(cut, 'a', '第 2 个码元是高代理，前移一位');
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut));
  assert.equal(truncateText(emoji, 3), 'a😀');
});

test('truncateText：max 非法/0 返回空串；空输入安全', () => {
  assert.equal(truncateText('abc', 0), '');
  assert.equal(truncateText('abc', 'x'), '');
  assert.equal(truncateText(null, 5), '');
});

test('truncateTextTail：保留尾部，不切开代理对', () => {
  assert.equal(truncateTextTail('abcdef', 3), 'def');
  const tail = truncateTextTail('a😀b', 2);
  assert.ok(!/^[\uDC00-\uDFFF]/.test(tail), `开头不能是孤立低代理：${JSON.stringify(tail)}`);
  assert.equal(truncateTextTail('a😀', 2), '😀', '正好切在 emoji 起点时保留完整字符');
  assert.equal(truncateTextTail('abc', 0), '');
  assert.equal(truncateTextTail(null, 3), '');
});
