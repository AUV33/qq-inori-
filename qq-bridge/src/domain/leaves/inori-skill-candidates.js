// inori-skill-candidates.js · 从成功轨迹里找“可能可以整理成技能”的候选（纯函数）
//
// 纪律：
//   · 只生成候选，不写 skills.json、不建 draft、不派学习任务；
//   · 同目标成功 N 次、步骤大致一致才算候选；
//   · 已有同名/高度相似的技能不再提示；
//   · 候选未确认就什么都不发生，下一次还会自然出现（由调用方做冷却）。

import crypto from 'node:crypto';

export const DEFAULTS = {
  minSuccess: 2,
  windowDays: 14,
  limit: 3,
  maxSteps: 8,
  goalSimilarity: 0.72,
  stepSimilarity: 0.3,
};

const clean = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[\s,，。.!！?？、;；:：'"“”‘’()（）[\]【】]/g, '')
  .slice(0, 80);

function bigrams(s) {
  const t = clean(s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function similarity(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const v of x) if (y.has(v)) inter += 1;
  return inter / (x.size + y.size - inter);
}

const timeOf = (row) => {
  const t = Date.parse(row?.at || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {Array<{goal:string,steps?:string[],result:string,at?:string,note?:string}>} traces
 * @param {{minSuccess?:number,windowDays?:number,now?:number,limit?:number,existingSkills?:Array}} opts
 * @returns {Array<{id:string,goal:string,count:number,steps:string[],lastAt:string,source:'trace'}>}
 */
export function detectSkillCandidates(traces, opts = {}) {
  const minSuccess = Math.max(2, Number(opts.minSuccess) || DEFAULTS.minSuccess);
  const windowDays = Math.max(1, Number(opts.windowDays) || DEFAULTS.windowDays);
  const now = Number(opts.now) || Date.now();
  const limit = Math.max(1, Number(opts.limit) || DEFAULTS.limit);
  const cutoff = now - windowDays * 86400000;
  const rows = (Array.isArray(traces) ? traces : [])
    .filter((r) => r && r.result === 'success' && String(r.goal || '').trim())
    .map((r) => ({ ...r, _t: timeOf(r) }))
    .filter((r) => r._t != null && r._t >= cutoff)
    .sort((a, b) => a._t - b._t);

  const groups = [];
  for (const row of rows) {
    const key = clean(row.goal);
    if (!key) continue;
    let group = groups.find((g) => similarity(g.key, key) >= DEFAULTS.goalSimilarity);
    if (!group) {
      group = { key, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }

  const existing = Array.isArray(opts.existingSkills) ? opts.existingSkills : [];
  const out = [];
  for (const group of groups) {
    if (group.rows.length < minSuccess) continue;
    const withSteps = group.rows.filter((r) => Array.isArray(r.steps) && r.steps.length);
    if (withSteps.length < minSuccess) continue;
    const latest = withSteps[withSteps.length - 1];
    const earlier = withSteps.slice(0, -1).slice(-3);
    const latestSteps = latest.steps.join(' ');
    // 只有最新一次与之前至少一次步骤相似，才认为“同一套做法”可整理。
    const coherent = earlier.some((r) => similarity(latestSteps, r.steps.join(' ')) >= DEFAULTS.stepSimilarity);
    if (!coherent) continue;

    const goalKey = group.key;
    const alreadyKnown = existing.some((s) => {
      if (!s || s.archived) return false;
      const name = clean(s.name);
      const desc = clean(s.desc);
      return name === goalKey
        || (name && similarity(name, goalKey) >= DEFAULTS.goalSimilarity)
        || (name && goalKey.includes(name))
        || (desc && similarity(desc, goalKey) >= 0.8);
    });
    if (alreadyKnown) continue;

    out.push({
      id: 'sc_' + crypto.createHash('sha1').update(goalKey).digest('hex').slice(0, 8),
      goal: String(latest.goal).slice(0, 120),
      count: group.rows.length,
      steps: latest.steps.slice(0, DEFAULTS.maxSteps).map((s) => String(s).slice(0, 160)),
      lastAt: latest.at,
      source: 'trace',
    });
  }

  return out
    .sort((a, b) => (b.count - a.count) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)))
    .slice(0, limit);
}

/** 渲染成一小段注入文本；没有候选返回空串。 */
export function renderSkillCandidates(list, { max = 1 } = {}) {
  const rows = (Array.isArray(list) ? list : []).slice(0, Math.max(1, Number(max) || 1));
  if (!rows.length) return '';
  return [
    '【可能可以整理成技能】',
    ...rows.map((c) => `- 「${c.goal}」成功做过 ${c.count} 次；步骤大概是：${c.steps.join(' → ')}`),
    '（如果这就是同一套做法，可以用 skill_save 记成技能；不想整理就忽略，不会自动入库。）',
  ].join('\n');
}

export { clean as normalizeGoal, similarity as goalSimilarity };
