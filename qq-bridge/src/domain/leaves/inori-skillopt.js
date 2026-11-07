// inori-skillopt.js · 技能「优化」而不是「淘汰」
//
// 用户口径：失败的技能不该直接退役，应该把失败点写进去、调低置信度、下次换法；
// 只有反复失败到没有改进空间时才降级（仍然保留，不删除）。
//
// 输入是 skills.json 的对象（{version, items:[...]}），返回改后的对象与一段说明。
import { applyOutcome } from './inori-skills.js';

function norm(t) {
  return String(t || '').toLowerCase();
}

// 安卓包名 → 人话别名（否则「com.hypergryph.arknights」永远匹配不到「明日方舟」的技能标签）
const APP_ALIASES = {
  'com.hypergryph.arknights': ['明日方舟', 'arknights', 'ark'],
  'com.tencent.tmgp.sgame': ['王者荣耀', '王者'],
  'com.miHoYo.Yuanshen': ['原神'],
  'com.tencent.mm': ['微信'],
  'com.tencent.mobileqq': ['QQ', 'qq'],
  'com.tencent.tmgp.pubgmhd': ['和平精英'],
  'com.netease.onmyoji': ['阴阳师'],
};

export function appAliases(app) {
  const s = String(app || '').toLowerCase();
  for (const [pkg, names] of Object.entries(APP_ALIASES)) {
    if (s.startsWith(pkg.toLowerCase())) return names;
  }
  return [];
}

/** 在技能列表里找和这次活动相关的技能：按标签/名称/描述匹配 app 关键词 */
export function matchSkill(skillsJson, { app = '', goal = '' } = {}) {
  const items = Array.isArray(skillsJson?.items) ? skillsJson.items : [];
  const hay = [String(app || ''), ...appAliases(app), String(goal || '')].join(' ').toLowerCase();
  const hits = items.filter((s) => {
    if (!s || s.deprecated) return false;
    const words = [norm(s.name), norm(s.desc), ...(Array.isArray(s.tags) ? s.tags.map(norm) : [])];
    return words.some((w) => w && (hay.includes(w.slice(0, 6)) || w.includes(hay.slice(0, 4))));
  });
  return hits[0] || null;
}

/**
 * 记录一次结果并优化技能。
 * @returns {{skill: object|null, changed: boolean, note: string}}
 */
export function optimizeSkill(skillsJson, { app = '', goal = '', stuck = false, steps = 0, hint = '' } = {}) {
  const item = matchSkill(skillsJson, { app, goal });
  if (!item) return { skill: null, changed: false, note: '' };
  // 成功/失败都走统一入口：写失败点、降/升置信度、连续失败只降级不删除
  if (stuck) {
    const fallback = '在「' + (app || '这个界面') + '」卡住了：同一个位置重复点没反应，下次先 dump 看控件再点，或换别的位置。';
    const h = String(hint || fallback).slice(0, 160);
    const skill = applyOutcome(skillsJson, item.id, { ok: false, hint: h, source: 'activity' });
    return { skill, changed: true, note: '「' + item.name + '」失败 +1（置信度 ' + (skill?.confidence ?? item.confidence) + '），已记下改进点' };
  }
  if (Number(steps) >= 3) {
    // [SKILL-TRUTH] 活动走通只算 attempt；没有 verify 不记 success。
    const skill = applyOutcome(skillsJson, item.id, { ok: null, source: 'activity' });
    return { skill, changed: true, note: '「' + item.name + '」记了一次尝试（活动走通；没有判据不算成功）' };
  }
  return { skill: item, changed: false, note: '' };
}
