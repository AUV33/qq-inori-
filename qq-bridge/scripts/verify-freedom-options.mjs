// verify-freedom-options.mjs · 自由度选项供给 1-4 的逻辑闭环检查
// 只读：不写她的状态，不改 prompt。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadGoals, renderOpenInvitation } from '../src/domain/leaves/inori-goals.js';
import { load as loadLearningItems, shouldInjectIntoPrompt, render as renderLearning } from '../src/domain/leaves/inori-learning-items.js';
import { load as loadSkills } from '../src/domain/leaves/inori-skills.js';
import { renderActivityMenu } from '../src/domain/conversation/activity-menu.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.resolve(root, '..', 'data', 'state');
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
const appSource = fs.readFileSync(path.join(root, 'src', 'app.mjs'), 'utf8');
for (const needle of ['shouldInjectLearningItem', 'renderGoalOpenInvitation', 'extraActivities, limit: 3']) {
  if (!appSource.includes(needle)) fail(`app.mjs 缺少接线：${needle}`);
}

// 1) 学习项不再进 ownlife，但私聊仍在
const learning = loadLearningItems(path.join(state, 'learning-items.json'));
if (shouldInjectIntoPrompt('private:10001', 'ownlife')) fail('学习项仍会注入 ownlife');
if (!shouldInjectIntoPrompt('private:10001', 'privateMessage')) fail('学习项在私聊也被关掉了');
if (!shouldInjectIntoPrompt('private:10001', 'probability')) fail('学习项在概率唤醒也被关掉了');
if (shouldInjectIntoPrompt('group:123456789', 'privateMessage')) fail('学习项注入群聊');

// 2) 活动池能带出非技能活动
const skills = loadSkills(path.join(state, 'skills.json')).items || [];
const activityData = JSON.parse(fs.readFileSync(path.join(state, 'activities.json'), 'utf8'));
const pool = Array.isArray(activityData._pool) ? activityData._pool : [];
if (pool.length < 5) fail(`activities._pool 太小：${pool.length}`);
const menu = renderActivityMenu(skills, { chance: 1, limit: 20, rng: () => 0, extraActivities: pool });
if (!menu.includes('发呆，什么都不做')) fail('活动菜单没有泛活动池');
if (!menu.includes('画世界')) fail('活动菜单丢了技能活动（画世界）');
if (!menu.includes('不用现在决定')) fail('活动菜单缺少许可措辞');

// 3) 目标空时给开放邀请，不自动建目标
const goals = loadGoals(path.join(state, 'goals.json'));
if (goals.some((g) => g.status === 'active')) fail('当前已有 active 目标，无法验证空池邀请');
const invite = renderOpenInvitation(goals);
if (!invite.includes('goal_add') || !invite.includes('不想记就空着')) fail('目标空池邀请不完整');

// 4) 手机打开兜底存在
const phoneSource = fs.readFileSync(path.resolve(root, '..', 'ai-companion-kit', 'packages', 'phone-mcp', 'src', 'phone-mcp.js'), 'utf8');
for (const needle of ['resolvePackageActivity', 'am start -n ${comp}', 'launchPackageByMonkey', 'monkey -p ${pkg}', 'DRAWER-FALLBACK', '应用抽屉第${page}页']) {
  if (!phoneSource.includes(needle)) fail(`phone_open_app 缺少兜底：${needle}`);
}

// 5) 渲染函数本身仍可用（不是只删了注入）
const sample = [{
  id: 'sample', title: '测试学习项', why: '测试', status: 'practicing',
  criterion: '测试判据', nextDrill: '测试下一步', evidence: [], tags: [],
}];
if (!renderLearning(sample, { lastByItem: {} }).includes('你正在练')) fail('学习项 render 失效');

console.log(JSON.stringify({
  ok: !process.exitCode,
  learningItem: shouldInjectIntoPrompt('private:1', 'ownlife') ? 'bad' : 'ownlife-hidden/private-visible',
  activityPool: pool.length,
  activeGoals: goals.filter((g) => g.status === 'active').length,
  goalInvite: Boolean(invite),
  phoneFallback: true,
}));
