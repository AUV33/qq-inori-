// inori-register 金标：从场合量出目标、看她偏了多少——问句也算一个维度；样本不足不下结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, computeStyleStats, targetFromScene, evaluateStyle, questionHint, describeStyle,
} from '../src/domain/leaves/inori-register.js';

test('computeStyleStats：空输入返回 {n:0}', () => {
  assert.deepEqual(computeStyleStats([]), { n: 0 });
  assert.deepEqual(computeStyleStats(null), { n: 0 });
  assert.deepEqual(computeStyleStats(['  ', '']), { n: 0 });
});

test('computeStyleStats：平均/中位/短句率/多逗号率', () => {
  const s = computeStyleStats(['好', '好的呀', '这是一句长一些的话', '嗯']);
  assert.equal(s.n, 4);
  assert.equal(s.avgLen, 3.5, '1+3+9+1 / 4');
  assert.equal(s.shortRatio, 0.75, '≤6 字算短句');
  assert.equal(s.multiCommaRatio, 0);
  assert.equal(computeStyleStats(['a，b，c']).multiCommaRatio, 1);
});

test('computeStyleStats：问句不靠问号也认（你几点睡 / 这个怎么弄）', () => {
  const s = computeStyleStats(['你几点睡', '这个怎么弄', '今天吃了面']);
  assert.equal(s.questionRate, 0.667);
});

test('computeStyleStats：表情与语气词收尾分开统计', () => {
  const s = computeStyleStats(['好啊😀', '走啦', '嗯嗯', '普通一句']);
  assert.equal(s.emojiRate, 0.25);
  assert.equal(s.particleRate, 0.5, '「走啦」与「嗯嗯」都以语气词收尾');
});

test('targetFromScene：样本不足返回 null', () => {
  assert.equal(targetFromScene({ n: 3, avgLen: 10, shortRatio: 0.5, medianLen: 10 }), null);
  assert.equal(targetFromScene(null), null);
});

test('targetFromScene：目标句长 = 场合 ×1.15 并夹在 5..14；短句率夹在 0.2..0.8', () => {
  const short = targetFromScene({ n: 10, avgLen: 1, shortRatio: 0.9, medianLen: 1, questionRate: 0.2 });
  assert.equal(short.targetAvg, DEFAULTS.targetFloor, '太短的目标抬到下限 5');
  assert.equal(short.targetShort, 0.8, '短句率上限 0.8');
  assert.ok(short.targetMedian >= 3);

  const long = targetFromScene({ n: 10, avgLen: 30, shortRatio: 0.1, medianLen: 20 });
  assert.equal(long.targetAvg, DEFAULTS.targetCeil, '太长的目标压到上限 14');
  assert.equal(long.targetShort, 0.2);
  assert.equal(long.targetQuestion, 0);
});

test('evaluateStyle：样本不足 → no_data', () => {
  assert.equal(evaluateStyle({ n: 2, avgLen: 10 }, { targetAvg: 8 }).verdict, 'no_data');
  assert.equal(evaluateStyle(null, { targetAvg: 8 }).verdict, 'no_data');
  assert.equal(evaluateStyle({ n: 10, avgLen: 10 }, null).verdict, 'no_data');
});

test('evaluateStyle：平均句长超出 2.5 字 → too_long 且提示可执行', () => {
  const r = evaluateStyle({ n: 10, avgLen: 12, shortRatio: 0.1 }, { targetAvg: 8, targetShort: 0.5 });
  assert.equal(r.verdict, 'too_long');
  assert.equal(r.gap, 4);
  assert.ok(r.hint.includes('一句话一条'), r.hint);
});

test('evaluateStyle：平均只差一点但短句率差太多 → 也算 too_long（落在分条上）', () => {
  const r = evaluateStyle({ n: 10, avgLen: 8.5, shortRatio: 0 }, { targetAvg: 8, targetShort: 0.58 });
  assert.equal(r.verdict, 'too_long');
  assert.ok(r.hint.includes('多断几句'), r.hint);
});

test('evaluateStyle：明显比场合短 → too_short；正常 → ok', () => {
  const short = evaluateStyle({ n: 10, avgLen: 3, shortRatio: 0.9 }, { targetAvg: 8, targetShort: 0.5 });
  assert.equal(short.verdict, 'too_short');
  assert.ok(short.hint.includes('可以说得完整一点'));
  assert.equal(evaluateStyle({ n: 10, avgLen: 8, shortRatio: 0.5 }, { targetAvg: 8, targetShort: 0.5 }).verdict, 'ok');
});

test('questionHint：样本不足/场合不问/她本来就常问 都不提示', () => {
  const scene = { n: 20, questionRate: 0.3 };
  const target = { targetQuestion: 0.3 };
  assert.equal(questionHint({ n: 5, questionRate: 0.3 }, { n: 20, questionRate: 0 }, target), null, '场合样本不足');
  assert.equal(questionHint(scene, { n: 5, questionRate: 0 }, target), null, '我的样本不足');
  assert.equal(questionHint({ n: 20, questionRate: 0.05 }, { n: 20, questionRate: 0 }, { targetQuestion: 0.05 }), null, '场合本来就不问');
  assert.equal(questionHint(scene, { n: 20, questionRate: 0.2 }, target), null, '她本来就常问');
});

test('questionHint：场合问得多、她几乎不问 → 给一句软提示（不催）', () => {
  const hint = questionHint({ n: 20, questionRate: 0.3 }, { n: 20, questionRate: 0 }, { targetQuestion: 0.3 });
  assert.ok(hint.includes('30%'));
  assert.ok(hint.includes('不用硬问'), '只给许可');
});

test('describeStyle：三种状态的人话', () => {
  assert.ok(describeStyle({ n: 10, avgLen: 8 }, { n: 20, avgLen: 10 }, { verdict: 'too_long', gap: 2 }).includes('差 2 字'));
  assert.ok(describeStyle(null, null, null).includes('场合样本不足'));
  assert.ok(describeStyle(null, null, null).includes('no_data'));
});
