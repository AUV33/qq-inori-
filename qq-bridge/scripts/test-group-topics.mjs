// test-group-topics.mjs · 群话题萃取：跨摘要频次、停用词、被长词包含的短词、渲染
import assert from 'node:assert';
import { extractTopics, renderGroupTopics } from '../src/domain/leaves/inori-group-facts.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const digests = [
  '群里在聊：新显卡价格又涨了，有人抢到 4090；他在纠结要不要换',
  '群里在聊：显卡驱动又崩了，重装一遍才好；顺便聊了会 4090',
  '群里在聊：生日那天谁去吃饭，生日蛋糕订哪家',
  '群里在聊：他生日快到了，生日礼物还没想好',
  '群里在聊：插件市场又被扫了，有人做了新的浏览器插件',
  '群里在聊：这个插件不错，能自动整理群消息',
];

check('extractTopics：具体话题能被提出来（显卡/生日/插件）', () => {
  const topics = extractTopics(digests, { limit: 10, minDf: 2 });
  const joined = topics.join(',');
  assert.ok(/显卡/.test(joined), joined);
  assert.ok(/生日/.test(joined), joined);
  assert.ok(/插件/.test(joined), joined);
});

check('extractTopics：停用词/纯笑声不进榜', () => {
  const topics = extractTopics(['哈哈哈 好的 嗯嗯 这个 那个', '哈哈哈 好的 嗯嗯 这个 那个'], { limit: 10, minDf: 2 });
  assert.ok(!topics.some((t) => ['哈哈', '好的', '嗯嗯', '这个', '那个'].includes(t)), JSON.stringify(topics));
});

check('renderGroupTopics：不足 3 个不写', () => {
  assert.equal(renderGroupTopics(['显卡', '生日']), '');
  assert.ok(renderGroupTopics(['显卡', '生日', '插件']).includes('显卡'));
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
