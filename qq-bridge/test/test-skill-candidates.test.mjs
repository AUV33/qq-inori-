import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSkillCandidates,
  renderSkillCandidates,
} from '../src/domain/leaves/inori-skill-candidates.js';

const now = Date.parse('2026-10-31T12:00:00+08:00');
const at = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
const row = (goal, steps, result = 'success', hoursAgo = 1) => ({ goal, steps, result, at: at(hoursAgo) });

test('同类目标成功 2 次、步骤一致 → 候选', () => {
  const list = detectSkillCandidates([
    row('装游戏', ['打开商店', '搜名字', '点安装'], 'success', 3),
    row('装游戏', ['打开商店', '搜名字', '点安装'], 'success', 1),
  ], { now });
  assert.equal(list.length, 1);
  assert.equal(list[0].goal, '装游戏');
  assert.equal(list[0].count, 2);
  assert.deepEqual(list[0].steps, ['打开商店', '搜名字', '点安装']);
});

test('只成功 1 次 → 不生成候选', () => {
  const list = detectSkillCandidates([row('装游戏', ['a'], 'success', 1)], { now });
  assert.deepEqual(list, []);
});

test('失败不算成功次数', () => {
  const list = detectSkillCandidates([
    row('装游戏', ['a'], 'success', 3),
    row('装游戏', ['a'], 'fail', 1),
  ], { now });
  assert.deepEqual(list, []);
});

test('已有同名/相似技能 → 不再提示', () => {
  const list = detectSkillCandidates([
    row('装游戏', ['a'], 'success', 3),
    row('装游戏', ['a'], 'success', 1),
  ], { now, existingSkills: [{ name: '装游戏', archived: false }] });
  assert.deepEqual(list, []);
});

test('步骤差异很大 → 不硬合并', () => {
  const list = detectSkillCandidates([
    row('装游戏', ['打开商店', '搜名字', '点安装'], 'success', 3),
    row('装游戏', ['打开浏览器', '搜攻略', '看视频'], 'success', 1),
  ], { now });
  assert.deepEqual(list, []);
});

test('窗口外/空目标不算', () => {
  const list = detectSkillCandidates([
    row('装游戏', ['a'], 'success', 24 * 20),
    row('', ['a'], 'success', 1),
    row('装游戏', ['a'], 'success', 1),
  ], { now });
  assert.deepEqual(list, []);
});

test('render 只给事实和许可，不催派任务', () => {
  const text = renderSkillCandidates([{ goal: '装游戏', count: 2, steps: ['a', 'b'] }]);
  assert.match(text, /装游戏/);
  assert.match(text, /成功做过 2 次/);
  assert.match(text, /skill_save/);
  assert.doesNotMatch(text, /必须|应该|任务/);
});
