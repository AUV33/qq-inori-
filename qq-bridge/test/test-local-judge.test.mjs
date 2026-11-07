// [LOCAL-JUDGE] 编排层回归锁：解析容错 / 规则优先 / 只在模糊时动模型 / 模型挂了降级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeJson, fuseJudgement, shouldJudge, buildJudgeMessages, correctTarget } from '../src/domain/memory/local-judge.js';

test('parseJudgeJson：容忍前后废话和代码块', () => {
  const a = parseJudgeJson('好的，结果如下：```json\n{"affect":"发火","target":"你","intent":"在骂人","confidence":0.9,"evidence":"烦不烦"}\n```');
  assert.equal(a.affect, '发火');
  assert.equal(a.target, '你');
  assert.equal(a.confidence, 0.9);
  const b = parseJudgeJson('{"affect":"平稳"');
  assert.equal(b, null);
});

test('parseJudgeJson：多标签/越界值被丢弃', () => {
  const r = parseJudgeJson('{"affect":"烦躁|不满","target":"你","intent":"x","confidence":0.95}');
  assert.equal(r.affect, null, '多标签不是合法单标签');
  assert.equal(r.target, '你');
  const c = parseJudgeJson('{"affect":"开心","target":"无","confidence":3}');
  assert.equal(c.confidence, 1, '置信度被夹到 1');
});

test('fuseJudgement：规则置信高 → 用规则，不采纳模型', () => {
  const out = fuseJudgement(
    { affect: '发火', confidence: 0.7, intent: '带火', evidence: ['傻'] },
    { affect: '玩笑', target: '你', confidence: 0.9, intent: '互怼' },
  );
  assert.equal(out.source, 'rule');
  assert.equal(out.affect, '发火');
});

test('fuseJudgement：规则拿不准 + 模型够自信 → 用模型', () => {
  const out = fuseJudgement(
    { affect: '平稳', confidence: 0.3, intent: '正常', evidence: [] },
    { affect: '试探', target: '你', confidence: 0.8, intent: '在确认', evidence: '嫌我烦' },
  );
  assert.equal(out.source, 'model');
  assert.equal(out.affect, '试探');
  assert.equal(out.target, '你');
});

test('fuseJudgement：两边都不够自信 → 退回规则并标 none', () => {
  const out = fuseJudgement({ affect: '平稳', confidence: 0.3 }, { affect: '发火', target: '你', confidence: 0.4 });
  assert.equal(out.source, 'none');
  assert.ok(out.confidence <= 0.4);
});

test('shouldJudge：短句/规则高置信都不动模型', () => {
  assert.equal(shouldJudge('嗯', { affect: '平稳', confidence: 0.3 }), false);
  assert.equal(shouldJudge('我真的撑不住了', { affect: '倾诉', confidence: 0.75 }), false);
  assert.equal(shouldJudge('你看我干嘛呀', { affect: '平稳', confidence: 0.3 }), true);
});

test('buildJudgeMessages：带上相似示例和单标签约束', () => {
  const msgs = buildJudgeMessages('你是不是嫌我烦', { examples: [{ text: '你是不是觉得我烦', affect: '试探', target: '你' }] });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /只输出一行 JSON/);
  assert.match(msgs[0].content, /类似的话当时是怎么判的/);
  assert.match(msgs[0].content, /试探/);
  assert.match(msgs[1].content, /你是不是嫌我烦/);
});


test('correctTarget：冲她说的消息不会"对别人"', () => {
  const fixed = correctTarget({ affect: '倾诉', target: '别人', confidence: 0.9, intent: 'x' }, { directed: true });
  assert.equal(fixed.target, '你');
  assert.ok(fixed.confidence < 0.9, '纠正后降置信');
  assert.equal(fixed.corrected, true);
});

test('correctTarget：不是冲她说的就不动', () => {
  const m = { affect: '发火', target: '别人', confidence: 0.8 };
  assert.deepEqual(correctTarget(m, { directed: false }), m);
});

test('correctTarget：本来就对/对自己 → 不动', () => {
  assert.equal(correctTarget({ affect: '试探', target: '你', confidence: 0.8 }, { directed: true }).corrected, undefined);
  assert.equal(correctTarget({ affect: '倾诉', target: '自己', confidence: 0.8 }, { directed: true }).target, '自己');
});
