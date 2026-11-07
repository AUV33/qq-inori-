// inori-persona-cues 金标：只认「被夸/被损/被求助」三类瞬间，只递事实+许可，不写台词。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPersonaCues, renderPersonaCue } from '../src/domain/leaves/inori-persona-cues.js';

test('detectPersonaCues：三类信号分别命中', () => {
  assert.deepEqual(detectPersonaCues(['你好厉害']), ['praise']);
  assert.deepEqual(detectPersonaCues(['笑死，就这']), ['tease']);
  assert.deepEqual(detectPersonaCues(['帮我查一下']), ['help']);
});

test('detectPersonaCues：可同时命中多类，顺序稳定（praise→tease→help）', () => {
  assert.deepEqual(detectPersonaCues(['谢谢，不过你行你上，帮我看看这个']), ['praise', 'tease', 'help']);
});

test('detectPersonaCues：空输入/非数组/空白都返回空', () => {
  assert.deepEqual(detectPersonaCues([]), []);
  assert.deepEqual(detectPersonaCues(null), []);
  assert.deepEqual(detectPersonaCues(['   ', '']), []);
});

test('renderPersonaCue：最多给 max 条，且都是「你定」的许可语气', () => {
  const text = renderPersonaCue(['好厉害', '笑死', '帮我'], { max: 2 });
  assert.ok(text.startsWith('【这会儿】'));
  assert.ok(text.includes('夸你'));
  assert.ok(text.includes('损你/拱火'));
  assert.ok(!text.includes('找你帮忙'), 'max=2 时第三条不该出现');
  assert.ok(/你定/.test(text), '必须是许可，不是命令');
});

test('renderPersonaCue：没有信号返回 null（调用方据此不加块）', () => {
  assert.equal(renderPersonaCue(['今天天气不错']), null);
  assert.equal(renderPersonaCue([]), null);
});
