// belief-seed.mjs · 用存量人物档案初始化信念库（迁移期的桥）
//
// 干什么：把 data/state/people.json 里的人（QQ id / owner / count / lastSeen）转成 PersonBelief，
//         让 BeliefStore 一上线就有“认识的人”，而不是空表。
// 为什么：信念库若要从零积累，A1/A4 需要数周才有数据；存量档案是真实互动证据，可直接播种。
// 输入输出：纯函数；people 对象进，BeliefStore 出（不读写文件）。
// 失败模式：脏条目跳过；count/lastSeen 缺失按 0 处理。
// 不做什么：不判断关系好坏（trust/affinity 保持中性）；不写盘；不合并 social-graph（下一步）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.3（信念库）

import { createBeliefStore, normalizeBeliefStore } from './belief-store.mjs';

export const BELIEF_SEED_VERSION = 1;
const DEFAULT_MAX_PEOPLE = 500;

function clamp01(x) {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  return Math.max(0, Math.min(1, n));
}

export function seedBeliefsFromPeople(people, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxPeople = Number.isFinite(opts.maxPeople) && opts.maxPeople > 0 ? opts.maxPeople : DEFAULT_MAX_PEOPLE;
  const store = createBeliefStore({ now });
  if (!people || typeof people !== 'object') return store;

  const rows = Object.entries(people)
    .filter(([id, p]) => id && p && typeof p === 'object')
    .sort(([, a], [, b]) => (Number(b?.count) || 0) - (Number(a?.count) || 0))
    .slice(0, maxPeople);

  for (const [id, p] of rows) {
    const count = Math.max(0, Number(p.count) || 0);
    // 熟悉度用对数饱和：见过 50 次 ≈ 0.63，200 次 ≈ 0.98，避免高频联系人一上来就 1。
    const familiarity = clamp01(1 - Math.exp(-count / 50));
    const lastSeen = Number(p.lastSeen) || Number(p.firstSeen) || 0;
    store.people[String(id)] = {
      v: 1,
      id: String(id),
      kind: p.owner ? 'private' : 'group_member',
      trust: 0.5,
      affinity: 0.5,
      reliability: 0.5,
      familiarity,
      topics: {},
      openLoops: [],
      boundaries: [],
      lastContactAt: lastSeen,
      lastDecayAt: now,
      interactionCount: Math.floor(count),
      evidence: [{ at: now, kind: 'seed', source: 'people.json', count }],
    };
  }
  return normalizeBeliefStore(store);
}
