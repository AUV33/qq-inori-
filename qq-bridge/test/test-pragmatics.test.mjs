import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPragmaticFrame, inferEmotionHypothesis, renderPragmaticBlock } from '../src/domain/leaves/inori-pragmatics.js';
import { createDiscourseState, updateDiscourseState, renderDiscourseBlock } from '../src/domain/leaves/inori-discourse-state.js';
import { createLanguageEpisode, findLanguageEpisodes, findLanguageEpisodesByContext, renderLanguageEpisodeBlock } from '../src/domain/leaves/inori-language-episodes.js';

test('请求 / 提问 / 吐槽 / 玩笑 / 试探的目标与需求', () => {
  const req = classifyPragmaticFrame('你能帮我看一下这个吗');
  assert.equal(req.speechAct, 'request');
  assert.equal(req.demand, 'act');
  assert.equal(req.target, 'her');
  const q = classifyPragmaticFrame('今天为什么这么热？');
  assert.equal(q.speechAct, 'question');
  assert.equal(q.demand, 'reply');
  const vent = classifyPragmaticFrame('烦死了，今天真受不了');
  assert.equal(vent.speechAct, 'vent');
  assert.equal(vent.demand, 'ack');
  const joke = classifyPragmaticFrame('哈哈哈哈哈笑死我了');
  assert.equal(joke.speechAct, 'joke');
  assert.equal(joke.stance, 'playful');
});

test('情绪是假设，带证据和替代解释；低置信度不硬判', () => {
  const e = inferEmotionHypothesis('好累，不想动了');
  assert.equal(e.label, 'tired');
  assert.ok(e.confidence > 0);
  assert.ok(e.evidence.length);
  assert.ok(e.alternatives.length);
  const u = inferEmotionHypothesis('今天周三');
  assert.equal(u.label, 'unknown');
});

test('渲染不写“你必须安慰”，只给线索', () => {
  const frame = classifyPragmaticFrame('烦死了，别管我');
  const text = renderPragmaticBlock(frame);
  assert.match(text, /【这句像是在】/);
  assert.match(text, /这是假设，不是诊断/);
  assert.doesNotMatch(text, /你必须|应该安慰/);
});

test('discourse：问题/搭话进入未闭环，话题更新', () => {
  let s = createDiscourseState();
  s = updateDiscourseState(s, { speechAct: 'question' }, { text: '你明天有空吗？', speaker: 'group:1', now: 1 });
  s = updateDiscourseState(s, { speechAct: 'bid' }, { text: '在吗', speaker: 'group:1', now: 2 });
  assert.equal(s.openQuestions.length, 1);
  assert.equal(s.openBids.length, 1);
  const text = renderDiscourseBlock(s);
  assert.match(text, /【还没答的】/);
  assert.match(text, /【像在等你接】/);
});

test('language episode：记录用法而不是词频', () => {
  const ep = createLanguageEpisode({ phrase: '绷不住了', context: '群里看到离谱图', meaning: '忍不住笑', register: '群聊玩笑', confidence: 0.7 });
  assert.equal(ep.used, false);
  assert.equal(findLanguageEpisodes([ep], '绷不住').length, 1);
  assert.equal(findLanguageEpisodesByContext([ep], '群里看到一张离谱图，忍不住笑').length, 1);
  assert.match(renderLanguageEpisodeBlock([ep]), /忍不住笑/);
});
