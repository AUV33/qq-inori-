// [AFFECT] 读别人状态的回归锁：只许"线索 → 假设"，不许贴标签、不许命令她怎么做
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCues, aggregateFeel, renderFeelHint } from '../src/domain/leaves/inori-affect.js';

test('明确求助 → 在倾诉/不太舒服，且建议先接情绪', () => {
  const r = detectCues('我真的撑不住了，工作压得我难受');
  assert.match(r.affect, /倾诉|舒服/);
  assert.match(r.note, /接情绪/);
  assert.ok(r.confidence >= 0.6);
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1);
});

test('带刺的话 → 烦躁/带火，不给"顶回去"的建议', () => {
  const r = detectCues('你他妈能不能别管我');
  assert.match(r.affect, /烦躁|带火/);
  assert.match(r.note, /别顶回去/);
});

test('“算了/没事”+ 连续短回复 → 低落/不想说', () => {
  const r = detectCues('算了', { recentShortReplies: 2 });
  assert.match(r.affect, /低落|不想说/);
});

test('试探句 → 不安/在确认，建议给确定性', () => {
  const r = detectCues('你是不是觉得我烦了');
  assert.match(r.affect, /不安|确认/);
  assert.match(r.note, /确定/);
});

test('玩笑 → 放松/在玩，允许接梗', () => {
  const r = detectCues('哈哈哈哈笑死我了草');
  assert.match(r.affect, /放松|玩/);
});

test('自责 → 内疚', () => {
  const r = detectCues('对不起，是我的错');
  assert.match(r.affect, /内疚/);
});

test('普通陈述 → 平稳，低置信度，不硬猜', () => {
  const r = detectCues('今天下午三点开会');
  assert.equal(r.affect, '平稳');
  assert.ok(r.confidence <= 0.35);
});

test('极简回复单独出现 → 只给弱假设', () => {
  const r = detectCues('嗯。');
  assert.ok(r.confidence <= 0.4);
  assert.match(r.note, /证据弱/);
});

test('aggregateFeel：多条都短 → 关闭的置信度被抬高', () => {
  const now = Date.now();
  const r = aggregateFeel([
    { text: '嗯', at: now - 6000 },
    { text: '哦', at: now - 5000 },
    { text: '算了', at: now - 4000 },
  ], { now });
  assert.ok(r.confidence >= 0.6);
  assert.ok(r.evidence.some((e) => /很短/.test(e)));
});

test('aggregateFeel：窗口外的旧情绪不挂到现在', () => {
  const now = Date.now();
  const r = aggregateFeel([
    { text: '我崩溃了想哭', at: now - 3600_000 },
    { text: '今天吃了面', at: now - 60_000 },
  ], { now });
  assert.equal(r.affect, '平稳');
});

test('renderFeelHint：低置信度不注入', () => {
  assert.equal(renderFeelHint({ affect: '平稳', confidence: 0.3, evidence: [], intent: '正常', note: '' }), '');
});

test('renderFeelHint：高置信度给出"假设 + 依据 + 可以无视"', () => {
  const text = renderFeelHint({ affect: '在倾诉', confidence: 0.75, evidence: ['求助/难受：“撑不住”'], intent: '想要被接住', note: '先接情绪' }, { who: '他' });
  assert.match(text, /他这会儿看起来/);
  assert.match(text, /依据：/);
  assert.match(text, /可能错/);
  assert.match(text, /按你自己的判断来/);
});

test('不会输出病名/诊断词', () => {
  const r = detectCues('我最近抑郁，什么都不想做');
  assert.ok(!/抑郁|焦虑症|心理疾病/.test(r.affect), r.affect);
});

test('方向盘：不是冲她来的火 → 标"在冲别人"，不让她对号入座', () => {
  const r = detectCues('太傻逼了这个人', { directedAtSelf: false });
  assert.match(r.affect, /别人/);
  assert.match(r.note, /别自动对号入座/);
});

test('群内互怼 + 笑声 → 玩笑，不是真火', () => {
  const r = detectCues('你这个傻蛋哈哈哈', { directedAtSelf: true, isGroup: true, laughInWindow: true });
  assert.match(r.affect, /互怼|玩笑/);
});

test('群里同样的词但没有笑声 → 仍按带火（保守）', () => {
  const r = detectCues('你个傻狗', { directedAtSelf: true, isGroup: true, laughInWindow: false });
  assert.match(r.affect, /烦躁|带火/);
});
