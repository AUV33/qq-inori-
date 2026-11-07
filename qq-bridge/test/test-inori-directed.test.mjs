// inori-directed 金标：「这句话是不是冲我来的」本地判定，含三处历史误判的回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDirectedAtAi, directedWhy, mentionsAi, stripQuote,
  AI_MENTION_RE, CHALLENGE_RE, QUESTION_RE, URGE_RE,
} from '../src/domain/leaves/inori-directed.js';

test('提到 AI 且有疑问/比较 → 冲她来的', () => {
  assert.equal(isDirectedAtAi('deepseek 是不是比 gpt 强'), true);
  assert.equal(directedWhy('claude 和 deepseek 哪个好'), 'ai+问');
  assert.equal(isDirectedAtAi('机器人会不会累'), true);
  assert.equal(isDirectedAtAi('ai 今天怎么样'), true);
});

test('「你/您」+ 疑问/比较 → 冲她来的', () => {
  assert.equal(directedWhy('你有claude一半强吗'), 'ai+问', '提到 AI 的规则优先');
  assert.equal(directedWhy('你有一半强吗'), '你+问');
  assert.equal(isDirectedAtAi('你是不是傻'), true);
  assert.equal(directedWhy('你行不行啊'), '你+问');
});

test('「你是…还是…」句式也认', () => {
  assert.equal(directedWhy('你是真人还是机器人'), '你是');
});

test('催促（不含裸「说话」）→ 冲她来的', () => {
  for (const s of ['人呢', '在不在', '回我一句', '怎么不说话', '别装死', '说话啊']) {
    assert.equal(isDirectedAtAi(s), true, s);
  }
  assert.equal(directedWhy('人呢'), '催促');
});

test('回归 1：裸「说话」不再算催促（群聊话题常带这个词）', () => {
  assert.equal(URGE_RE.test('刚睡醒迷迷沉沉的怎么可能说话能说成这样'), false);
  assert.equal(isDirectedAtAi('刚睡醒迷迷沉沉的怎么可能说话能说成这样'), false);
  assert.equal(isDirectedAtAi('然后说话'), false);
});

test('回归 2：转述前缀里的正文不算本条内容（引用里的「你设置的？」不该命中）', () => {
  const quoted = '[引用 某人：你设置的？]@小满 真话';
  assert.equal(stripQuote(quoted), '@小满 真话');
  assert.equal(isDirectedAtAi(quoted), false, '引用里别人的话不该触发');
  assert.equal(stripQuote('没有引用的普通话'), '没有引用的普通话');
});

test('回归 3：单字名不进关键词表（祈求/祈祷这类常见词不误触发）', () => {
  assert.equal(isDirectedAtAi('祈求明天别下雨'), false);
  assert.equal(isDirectedAtAi('祈祷能过'), false);
});

test('mentionsAi：只认 AI 相关称呼，不受疑问影响', () => {
  assert.equal(mentionsAi('今天 gpt 好慢'), true);
  assert.equal(mentionsAi('大肥鱼在吗'), true);
  assert.equal(mentionsAi('今天天气不错'), false);
  assert.equal(mentionsAi(''), false);
});

test('空值与平常闲聊都返回 false/null', () => {
  assert.equal(isDirectedAtAi(''), false);
  assert.equal(isDirectedAtAi(null), false);
  assert.equal(directedWhy(''), null);
  assert.equal(directedWhy('今天吃了面，还行'), null);
});

test('导出的四个正则都是可用的 RegExp（便于调参与测试）', () => {
  for (const re of [AI_MENTION_RE, CHALLENGE_RE, QUESTION_RE, URGE_RE]) assert.ok(re instanceof RegExp);
});

test('引用剥离后：她自己的话仍要判，引用里别人的话不判', () => {
  assert.equal(isDirectedAtAi('[引用 某人：随便]@小满 你会戳一戳吗'), true, '引用前缀之外的话仍是她的话');
  assert.equal(isDirectedAtAi('[引用 群友丙：你设置的？]@示例群友 是的'), false);
});

test('directedWhy 的映射：你+问 / 催促；日常闲聊为 null', () => {
  assert.equal(directedWhy('你会戳一戳吗'), '你+问');
  assert.equal(directedWhy('人呢'), '催促');
  for (const s of ['晚安', '群里在聊游戏', '明天见', '这个皮肤好看']) assert.equal(isDirectedAtAi(s), false, s);
});

test('脏输入：数字/对象/null 都不炸', () => {
  for (const v of [null, undefined, '', '   ', 0, {}]) assert.equal(isDirectedAtAi(v), false);
  assert.equal(stripQuote(null), '');
  assert.equal(mentionsAi('用deepseek写的'), true);
  assert.equal(mentionsAi('今天天气'), false);
});
