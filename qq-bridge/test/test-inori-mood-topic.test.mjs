// inori-mood-topic 金标：话题分类（加权命中 + 同分优先级）与「只给倾向、不给台词」的回复决策。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, classifyTopic, decide, moodLine } from '../src/domain/leaves/inori-mood-topic.js';

test('classifyTopic：情绪/身体权重更高，日常最轻', () => {
  assert.equal(classifyTopic('今天好想你').type, 'emotion');
  assert.equal(classifyTopic('今天有点头疼').type, 'body');
  assert.equal(classifyTopic('今天加班到很晚').type, 'work');
  assert.equal(classifyTopic('今天吃了面').type, 'daily');
  assert.equal(classifyTopic('哈哈哈笑死').type, 'joke');
  assert.equal(classifyTopic('晚安宝贝').type, 'intimate');
});

test('classifyTopic：同权重时按 情绪>身体>亲密>工作>玩笑>日常 优先', () => {
  // 「难过」= emotion(1.5)，「发烧」= body(1.3) → emotion
  const r = classifyTopic('我发烧了很难过');
  assert.equal(r.type, 'emotion');
  assert.ok(r.weighted.emotion > r.weighted.body);
});

test('classifyTopic：没有命中就是 daily；空输入安全', () => {
  const none = classifyTopic('随便说点什么');
  assert.equal(none.type, 'daily');
  assert.equal(none.hits, 0);
  assert.deepEqual(classifyTopic(null).scores, { emotion: 0, body: 0, work: 0, joke: 0, intimate: 0, daily: 0 });
});

test('TOPICS 常量与分类结果对齐', () => {
  assert.deepEqual(TOPICS, ['emotion', 'body', 'work', 'joke', 'daily', 'intimate']);
  for (const t of TOPICS) assert.equal(typeof classifyTopic('随便').scores[t], 'number');
});

test('decide：常态基线（0.95 / 60 / normal）', () => {
  const d = decide({ warmth: 0.5, energy: 0.6 }, { type: 'daily' });
  assert.equal(d.replyProb, 0.95);
  assert.equal(d.maxChars, 60);
  assert.equal(d.tone, 'normal');
  assert.equal(d.topic, 'daily');
});

test('decide：精力低 → 更少回、更短、lazy；精力很低时上限压到 20', () => {
  const low = decide({ warmth: 0.5, energy: 0.2 }, { type: 'daily' });
  assert.ok(low.replyProb < 0.95);
  assert.ok(low.maxChars <= 20);
  assert.equal(low.tone, 'lazy');
  assert.ok(low.reason.includes('精力低'));

  const mid = decide({ warmth: 0.5, energy: 0.4 }, { type: 'daily' });
  assert.equal(mid.tone, 'lazy');
  assert.ok(mid.replyProb < 0.95 && mid.replyProb > low.replyProb);
});

test('decide：情绪/亲密话题不能装死——暖时 0.97/400/earnest，冷时 0.85/120', () => {
  const warm = decide({ warmth: 0.8, energy: 0.8 }, { type: 'emotion' });
  assert.equal(warm.replyProb, 0.97);
  assert.equal(warm.maxChars, 400);
  assert.equal(warm.tone, 'earnest');

  // 托底只「抬」不「压」：基线 0.95 已经高于冷态的 0.85，所以概率仍是 0.95；
  // 但字数上限按冷暖区分（冷 → 120）。
  const cold = decide({ warmth: 0.3, energy: 0.8 }, { type: 'intimate' });
  assert.equal(cold.replyProb, 0.95);
  assert.equal(cold.maxChars, 120);
});

test('decide：身体/工作至少 0.8 与 80 字', () => {
  const d = decide({ warmth: 0.4, energy: 0.4 }, { type: 'work' });
  assert.ok(d.replyProb >= 0.8);
  assert.ok(d.maxChars >= 80);
  assert.ok(d.reason.includes('认真'));
});

test('decide：他难受时优先于话题与状态（neg>=0.5 必须认真在）', () => {
  const d = decide({ warmth: 0.2, energy: 0.1 }, { type: 'daily' }, { negScore: 0.7 });
  assert.ok(d.replyProb >= 0.95);
  assert.ok(d.maxChars >= 200);
  assert.equal(d.tone, 'earnest');
  assert.ok(d.reason.includes('必须在'));

  const mid = decide({ warmth: 0.5, energy: 0.6 }, { type: 'daily' }, { negScore: 0.4 });
  assert.ok(mid.replyProb >= 0.85);
  assert.ok(mid.maxChars >= 120);
});

test('decide：温度极端时收窄/放大，且概率与字数都被夹在合法区间', () => {
  const cold = decide({ warmth: 0.1, energy: 0.9 }, { type: 'daily' });
  assert.ok(cold.maxChars <= 15);
  assert.equal(cold.tone, 'lazy');

  const hot = decide({ warmth: 0.9, energy: 0.9 }, { type: 'daily' });
  assert.ok(hot.maxChars >= 120);
  assert.equal(hot.tone, 'earnest');

  for (const d of [cold, hot, decide({}, {})]) {
    assert.ok(d.replyProb >= 0.05 && d.replyProb <= 0.99);
    assert.ok(d.maxChars >= 5);
  }
});

test('moodLine：关掉返回空串；否则带心情/身体/话题/语气与「不想回也可以」的许可', () => {
  assert.equal(moodLine({ enabled: false }, {}), '');
  const line = moodLine({ warmth: 0.2, energy: 0.2 }, { tone: 'lazy', topic: 'emotion', negativity: 0.6 });
  assert.ok(line.includes('心情有点冷（0.20）'));
  assert.ok(line.includes('身体很累（0.20）'));
  assert.ok(line.includes('在说心情'));
  assert.ok(line.includes('不太想动'));
  assert.ok(line.includes('别用轻飘飘的语气回'));
  assert.ok(line.includes('不想回也可以不回'));
});
