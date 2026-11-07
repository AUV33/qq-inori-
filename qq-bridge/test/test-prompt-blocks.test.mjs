// [PROMPT-BLOCKS] 声明式块装配器的契约：顺序、条件、统计、与 join 逐字节一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleBlocks, sumByTier } from '../src/domain/persona/prompt-blocks.mjs';

test('字符串块：输出与 join 完全一致（迁移期零差异）', () => {
  const parts = ['【A】a\n\n', '', '【B】b\n\n'];
  assert.equal(assembleBlocks(parts).text, parts.join(''));
});

test('对象块：按声明顺序拼接，空文本跳过', () => {
  const out = assembleBlocks([
    { id: 'a', tier: 'core', text: 'A' },
    { id: 'b', tier: 'ref', text: '' },
    { id: 'c', text: 'C' },
  ]);
  assert.equal(out.text, 'AC');
  assert.deepEqual(out.blocks.map((b) => b.id), ['a', 'c']);
});

test('when：false 跳过、函数按 ctx 求值、缺省为真', () => {
  const blocks = [
    { id: 'always', text: '1' },
    { id: 'never', text: '2', when: false },
    { id: 'ctx-ok', text: '3', when: (ctx) => ctx?.on === true },
    { id: 'ctx-no', text: '4', when: (ctx) => ctx?.on === 'x' },
  ];
  const out = assembleBlocks(blocks, { ctx: { on: true } });
  assert.equal(out.text, '13');
  assert.deepEqual(out.skipped, ['never', 'ctx-no']);
  const out2 = assembleBlocks(blocks, { ctx: {} });
  assert.equal(out2.text, '1');
});

test('统计：每个保留块的字数 + 按层汇总', () => {
  const out = assembleBlocks([
    { id: 'a', tier: 'core', text: '你好' },
    { id: 'b', tier: 'core', text: '世界!' },
    { id: 'c', tier: 'late', text: '尾' },
  ]);
  assert.deepEqual(out.blocks.map((b) => [b.id, b.chars]), [['a', 2], ['b', 3], ['c', 1]]);
  assert.deepEqual(sumByTier(out), { core: 5, late: 1 });
  assert.equal(out.total, 6);
});

test('异常输入：非数组 / null 块 / 无 text', () => {
  assert.equal(assembleBlocks(null).text, '');
  assert.equal(assembleBlocks([null, undefined, 42]).text, '');
  assert.equal(assembleBlocks([{ id: 'x' }]).text, '');
});
