// inori-skill-candidates 金标：只生成候选不写库；同目标成功多次 + 步骤一致才算；已有技能不提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, detectSkillCandidates, renderSkillCandidates } from '../src/domain/leaves/inori-skill-candidates.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const at = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const trace = (goal, dayAgo, steps = ['打开应用', '点按钮', '确认']) => ({ goal, steps, result: 'success', at: at(dayAgo) });

test('同目标成功 ≥2 次且步骤相似 → 生成一个候选', () => {
  const list = detectSkillCandidates([
    trace('给方舟换班', 3),
    trace('给方舟换班', 1),
  ], { now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].goal, '给方舟换班');
  assert.equal(list[0].count, 2);
  assert.equal(list[0].source, 'trace');
  assert.deepEqual(list[0].steps, ['打开应用', '点按钮', '确认']);
  assert.ok(list[0].id.startsWith('sc_'));
});

test('成功次数不足 / 失败轨迹 / 没有步骤 都不算候选', () => {
  assert.deepEqual(detectSkillCandidates([trace('只成功一次', 1)], { now: NOW }), []);
  assert.deepEqual(detectSkillCandidates([
    { goal: '失败了', steps: ['a', 'b'], result: 'fail', at: at(1) },
    { goal: '失败了', steps: ['a', 'b'], result: 'fail', at: at(2) },
  ], { now: NOW }), []);
  assert.deepEqual(detectSkillCandidates([
    { goal: '没步骤', result: 'success', at: at(1) },
    { goal: '没步骤', result: 'success', at: at(2) },
  ], { now: NOW }), []);
});

test('窗口外的成功不算（默认 14 天）', () => {
  assert.deepEqual(detectSkillCandidates([
    trace('很久以前', 30),
    trace('很久以前', 29),
  ], { now: NOW }), []);
});

test('步骤不一致 → 不算「同一套做法」', () => {
  const list = detectSkillCandidates([
    trace('做某事', 3, ['开机', '连网', '下载', '安装', '配置']),
    trace('做某事', 1, ['打开相册', '选照片', '发出去']),
  ], { now: NOW });
  assert.deepEqual(list, []);
});

test('已有同名/高度相似技能的候选不再提示（归档的不算占位）', () => {
  const traces = [trace('给方舟换班', 3), trace('给方舟换班', 1)];
  assert.deepEqual(detectSkillCandidates(traces, { now: NOW, existingSkills: [{ name: '给方舟换班' }] }), []);
  assert.deepEqual(detectSkillCandidates(traces, { now: NOW, existingSkills: [{ name: '给方舟换' }] }), [], '包含关系也认');
  assert.equal(detectSkillCandidates(traces, { now: NOW, existingSkills: [{ name: '给方舟换班', archived: true }] }).length, 1, '归档技能不占位');
});

test('limit 与排序：次数多的在前，同次数按最近时间', () => {
  const traces = [
    trace('任务甲', 5), trace('任务甲', 1), trace('任务甲', 2),
    trace('任务乙', 3), trace('任务乙', 2),
    trace('任务丙', 4), trace('任务丙', 3),
  ];
  const list = detectSkillCandidates(traces, { now: NOW, limit: 2 });
  assert.equal(list.length, 2);
  assert.equal(list[0].goal, '任务甲');
  assert.ok(list[0].count >= list[1].count);
});

test('goal 只保留最新一次、步骤截断到 160 字与 maxSteps', () => {
  const many = Array.from({ length: 20 }, (_, i) => `步骤${i}` + '啊'.repeat(200));
  const list = detectSkillCandidates([
    trace('长步骤', 3, many),
    trace('长步骤', 1, many),
  ], { now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].steps.length, DEFAULTS.maxSteps);
  assert.ok(list[0].steps.every((s) => s.length <= 160));
});

test('renderSkillCandidates：空列表返回空串；有候选时带「不整理就忽略」的许可', () => {
  assert.equal(renderSkillCandidates([]), '');
  const text = renderSkillCandidates([{ goal: '给方舟换班', count: 2, steps: ['a', 'b'] }]);
  assert.ok(text.includes('【可能可以整理成技能】'));
  assert.ok(text.includes('「给方舟换班」成功做过 2 次'));
  assert.ok(text.includes('步骤大概是：a → b'));
  assert.ok(text.includes('不想整理就忽略'));
});
