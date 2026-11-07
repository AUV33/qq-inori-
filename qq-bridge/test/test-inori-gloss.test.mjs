// inori-gloss 金标：未知词检测——词界过滤、碎屑挡板、已知词排除、拉丁串优先。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTerms, findUnknown, renderUnknown } from '../src/domain/leaves/inori-gloss.js';

test('extractTerms：拉丁缩写/梗被抽出并小写；文件后缀与协议被排除', () => {
  const terms = extractTerms('他说的 yyds 你懂吗 XSWL');
  assert.ok(terms.has('yyds'));
  assert.ok(terms.has('xswl'), '统一小写');
  const noise = extractTerms('看这个 https://a.com/x.png 和 a.json');
  assert.equal(noise.has('https'), false);
  assert.equal(noise.has('png'), false);
  assert.equal(noise.has('json'), false);
});

test('extractTerms：占位符/事件标记先剥掉（不切出「图片/拍一」碎屑）', () => {
  const terms = extractTerms('[图片]【拍一拍】绷不住了');
  assert.equal(terms.has('图片'), false);
  assert.equal(terms.has('拍一'), false);
  assert.ok([...terms].some((t) => t.includes('绷')));
});

test('extractTerms：中文只取两边有词界的 2 字词（嵌在汉字串里的碎屑丢掉）', () => {
  const terms = extractTerms('另外就是他把基建弄完了');
  assert.equal(terms.has('另外'), false, '停用词');
  assert.equal(terms.has('外就'), false, '纯汉字串里的碎屑');
  assert.equal(terms.has('基建'), false, '夹在汉字中间（前「他」后「弄」）');
  const bounded = extractTerms('他在搞基建。');
  assert.ok(bounded.has('基建'), '有标点/句界就算词');
});

test('extractTerms：功能字组成的 2 字串、助词结尾、代词开头都丢掉', () => {
  const terms = extractTerms('那些 我的 党了 你们 好吗');
  for (const bad of ['那些', '我的', '党了', '你们', '好吗']) assert.equal(terms.has(bad), false, bad);
});

test('findUnknown：出现≥2 条消息且 lessons 里没有的才算未知', () => {
  const messages = [{ text: 'yyds 真强' }, { text: 'yyds 到底啥意思' }, { text: '绷不住了' }];
  const list = findUnknown(messages, '');
  assert.ok(list.some((x) => x.term === 'yyds' && x.hits === 2));
  assert.equal(list.some((x) => x.term === '绷不住'), false, '只出现一次不够');
});

test('findUnknown：已知词（lessons 里出现过）排除，大小写不敏感', () => {
  const messages = [{ text: 'YYDS 真强' }, { text: 'yyds 太强了' }];
  assert.deepEqual(findUnknown(messages, '我学过 yyds 的意思'), []);
});

test('findUnknown：同一条消息里重复出现只算一次', () => {
  const messages = [{ text: 'yyds yyds yyds' }];
  assert.deepEqual(findUnknown(messages, ''), [], '只有一条消息，hits=1');
});

test('findUnknown：拉丁串优先，其次按出现次数，最多 6 个', () => {
  const messages = [];
  for (let i = 0; i < 8; i += 1) messages.push({ text: '中文词汇' }, { text: 'yyds' });
  const list = findUnknown(messages, '', { limit: 8 });
  assert.ok(list.length <= 6, '上限 6，不刷屏');
  assert.ok(/[a-z]{2}/.test(list[0].term), '拉丁串排第一');
});

test('renderUnknown：空列表返回空串；有内容时给出清单与纪律', () => {
  assert.equal(renderUnknown([]), '');
  assert.equal(renderUnknown(null), '');
  const text = renderUnknown([{ term: 'yyds', hits: 2 }]);
  assert.ok(text.includes('yyds'));
  assert.ok(text.includes('lesson_write'));
  assert.ok(text.includes('别照抄定义'), '只给许可与纪律，不替她写');
});
