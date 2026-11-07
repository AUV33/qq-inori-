// activity-context.mjs · 「打开一个 App 之后她能做什么」的渲染（纯函数 + 只读技能库）
//
// 为什么（2026-10-30 主人拍板）：
//   「赚龙门币」不是独立方向，是「玩明日方舟」这件事里的步骤；她应该在**打开之后**
//   才知道自己能干什么、要去干什么，而不是每小时被当成一条待办推一次。
//
// 纪律：
//   代码里不写任何 App 名 / 包名 / 别名表 —— App ↔ 活动 的对应只来自技能库里的
//   `activity` / `app` 字段（数据），这里只做「按 app 字段匹配 + 渲染」。
//
// 数据形状（data/state/skills.json 的一条技能，可选字段）：
//   { name, steps: [...], activity: '明日方舟', app: 'com.hypergryph.arknights', retired?, archived? }
//
// 纯函数、零副作用；文件读取失败一律降级为空列表（不许因为技能库坏了就打不开 App）。
import fs from 'node:fs';
import { statePath } from './inori-paths.mjs';

/** 技能库路径：默认 data/state/skills.json，可用 INORI_SKILLS_FILE 覆盖（测试用）。 */
export const defaultSkillsFile = () => process.env.INORI_SKILLS_FILE || statePath('skills.json');

/** 活动附加数据（"这个里还能做什么"）：默认 data/state/activities.json，可用 INORI_ACTIVITIES_FILE 覆盖。 */
export const defaultActivitiesFile = () => process.env.INORI_ACTIVITIES_FILE || statePath('activities.json');

/**
 * 读某个活动的「还能干什么」清单（数据文件里手写，代码不写游戏知识）。
 * 只列事情的名字，不写坐标/步骤——步骤要她自己在做的时候记。
 */
export function readActivityExtras(activity, file = defaultActivitiesFile()) {
  const name = String(activity || '').trim();
  if (!name) return [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = j?.[name];
    const list = Array.isArray(row?.alsoDoable) ? row.alsoDoable : [];
    return list.map((x) => String(x || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 读技能库的 items；文件不存在/坏 JSON 都返回 []。 */
export function readSkillsFile(file = defaultSkillsFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

/** 一条技能的 app 字段 → 字符串数组（允许单个字符串或数组）。 */
export function appsOf(skill) {
  if (!skill || skill.app === undefined || skill.app === null) return [];
  return [].concat(skill.app).map((a) => String(a || '').trim()).filter(Boolean);
}

/** 取出「这个包名」对应的、还活着的技能。 */
export function skillsForApp(items, app) {
  const target = String(app || '').trim();
  if (!target) return [];
  return (Array.isArray(items) ? items : []).filter(
    (s) => s && !s.retired && !s.archived && appsOf(s).includes(target),
  );
}

/** 这批技能共同的活动名（取第一条写了 activity 的）；没有返回 ''。 */
export function activityName(skills) {
  for (const s of Array.isArray(skills) ? skills : []) {
    const name = String(s?.activity || '').trim();
    if (name) return name;
  }
  return '';
}

/** 第 1 步摘要：一行、最多 60 字（够她认出「这是哪件活」，不把整段步骤灌进去）。 */
export function firstStepSummary(skill, max = 60) {
  const step = Array.isArray(skill?.steps) && skill.steps.length ? String(skill.steps[0] || '') : '';
  const text = step.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 从清单里随机取 n 条（顺序也打乱；rng 可注入，测试可复现）。 */
export function pickRandom(list, n = 2, rng = Math.random) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  const arr = (Array.isArray(list) ? list : []).slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(roll() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, Math.max(0, Number(n) || 0));
}

/**
 * 渲染「打开之后」的那一段。没有技能就返回空串（不硬凑、不造暗示）。
 * @param {Array} skills
 * @param {{activity?: string, alsoDoable?: string[], rng?: () => number}} [opts]
 *   activity   可由调用方覆盖（默认取技能数据里的）
 *   alsoDoable 「这个里还能做什么」（数据文件里的清单，只列名字、不写步骤）
 */
export function renderActivityContext(skills, { activity = '', alsoDoable = [], rng = Math.random } = {}) {
  const list = (Array.isArray(skills) ? skills : []).filter((s) => s && !s.retired && !s.archived);
  if (!list.length) return '';
  const name = String(activity || activityName(list)).trim();
  const head = name ? `【打开了「${name}」】` : '【打开了这个 App】';
  const lines = list.slice(0, 6).map((s) => `- ${s.name}：${firstStepSummary(s) || '（步骤还没写）'}`);
  const extras = pickRandom(
    (Array.isArray(alsoDoable) ? alsoDoable : []).map((x) => String(x || '').trim()).filter(Boolean),
    2,
    rng,
  );
  const tail = extras.length ? `\n这个里也还能：${extras.join('、')}（步骤你还没学会，想试就试）。` : '';
  return `\n\n${head}你在这个里会做的事：\n${lines.join('\n')}\n这次干哪件、干到什么程度，你自己看着来。${tail}`;
}
