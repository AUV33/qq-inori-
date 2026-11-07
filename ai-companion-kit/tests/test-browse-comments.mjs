// test-browse-comments.mjs · 豆瓣话题评论解析（逛帖时把评论一起带回来）
import assert from 'node:assert';
import { doubanTopicId, parseDoubanComments } from '../packages/memory-mcp/src/browse-tool.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('识别豆瓣话题 id（www 与 m）', () => {
  assert.equal(doubanTopicId('https://www.douban.com/group/topic/503077552/'), '503077552');
  assert.equal(doubanTopicId('https://m.douban.com/group/topic/123'), '123');
  assert.equal(doubanTopicId('https://www.douban.com/group/explore'), null);
});

check('评论解析：作者前缀、去 HTML、去重、限长', () => {
  const json = {
    comments: [
      { text: '没开暖气这一个月是我最痛恨的时间', author: { name: '甲' } },
      { text: '<p>没开暖气这一个月是我最痛恨的时间</p>', author: { name: '乙' } }, // 重复（去标签后一样）
      { text: '   ', author: { name: '丙' } }, // 空
      { text: 'x'.repeat(200), author: { name: '' } }, // 超长
    ],
  };
  const out = parseDoubanComments(json, { max: 8, maxChars: 40 });
  assert.equal(out.length, 2);
  assert.equal(out[0], '甲：没开暖气这一个月是我最痛恨的时间');
  assert.ok(out[1].length <= 41, '长评论要截断');
});

check('空 JSON / 缺字段不炸', () => {
  assert.deepEqual(parseDoubanComments(null), []);
  assert.deepEqual(parseDoubanComments({}), []);
  assert.deepEqual(parseDoubanComments({ comments: 'not-array' }), []);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
