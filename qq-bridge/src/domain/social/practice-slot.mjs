// practice-slot.mjs · 「练手位」的挑选规则（纯函数，零 IO）
//
// 背景（2026-10-29）：自主时间的【练手位】每小时把「学过但还没做成过」的技能摆到她眼前。
// 旧规则只筛 injected>0 && success==0，再按 injected 降序取前 2 —— 于是「明日方舟 adb 部署干员」
// （injected 2709、success 0）每次必中、每小时推一次「再试一次」，做不成 → 继续推 → 再做，
// 变成她自己都停不下来的循环。
//
// [PRACTICE-V2 2026-10-31] 增加 polish 档：已经做成过、但 mastery 还没到 target 且写了 nextDrill
// 的技能，可以进「打磨位」——每次只摆一条，不催、不设配额。成功一次不等于做好。
//
// 现在的口径：
//   learn  = 新学、还没怎么试过（injected < 阈值，success == 0）
//   polish = 做成过（success > 0）且写了 nextDrill、mastery < target
//   stuck  = 试过很多次仍 0 成功（先放着，不再每小时推）
//
// 阈值只影响是否摆到眼前，不改技能数据，也不替她 retire。

export const DEFAULT_MAX_INJECTED = 120;
export const DEFAULT_MASTERY_TARGET = 0.8;

// [ACTIVITY-SCOPE] 2026-10-30：有活动归属的技能（写了 activity / app）不进泛练手位。
// 它们只在「打开那个 App」的那一刻由 activity-context 递给她才有意义。
const activityScoped = (s) =>
  Boolean(String(s?.activity || '').trim()) || Boolean([].concat(s?.app ?? []).map((a) => String(a || '').trim()).filter(Boolean).length);

/**
 * @param {Array} items
 * @param {{maxInjected?:number, limit?:number, masteryTarget?:number}} [opts]
 * @returns {{fresh:Array, polish:Array, stuck:Array}}
 */
export function pickPracticeSlots(items, { maxInjected = DEFAULT_MAX_INJECTED, limit = 2, masteryTarget = DEFAULT_MASTERY_TARGET } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(
    (s) => s && !s.retired && !s.archived && !activityScoped(s),
  );
  const cap = Number.isFinite(Number(maxInjected)) ? Math.max(1, Number(maxInjected)) : DEFAULT_MAX_INJECTED;
  const target = Number.isFinite(Number(masteryTarget)) ? Number(masteryTarget) : DEFAULT_MASTERY_TARGET;
  const learning = list.filter((s) => (Number(s.injected) || 0) > 0 && (Number(s.success) || 0) === 0);
  const fresh = learning
    .filter((s) => Number(s.injected) < cap)
    .sort((a, b) => (Number(b.injected) || 0) - (Number(a.injected) || 0))
    .slice(0, Math.max(0, Number(limit) || 0));
  const stuck = learning.filter((s) => Number(s.injected) >= cap);
  // 打磨位只收“做成过 + 有下一步 + 还没到目标”的；没有 nextDrill 的不硬凑。
  const polish = list
    .filter((s) => (Number(s.success) || 0) > 0 && String(s.nextDrill || '').trim())
    .filter((s) => Number(s.mastery ?? 0) < target)
    .sort((a, b) => Number(a.mastery ?? 0) - Number(b.mastery ?? 0))
    .slice(0, Math.max(0, Number(limit) || 0));
  return { fresh, polish, stuck };
}

/**
 * 渲染【练手位】。没有可练的就返回空串（不硬凑、也不拿「搁着的」凑数）。
 * 一次最多只摆一条：优先 learn，其次 polish。
 */
export function renderPracticeSlots(items, opts = {}) {
  const { fresh, polish } = pickPracticeSlots(items, opts);
  const pick = fresh[0] || polish[0];
  if (!pick) return '';
  const kind = fresh[0] ? '新学' : '打磨';
  const line = kind === '新学'
    ? `- 「${pick.name}」注入过 ${pick.injected || 0} 次、还没做成过；判据：${String(pick.verify || '没写').slice(0, 60)}`
    : `- 「${pick.name}」已经做成过，但还没到你说的目标；下一步：${String(pick.nextDrill || '自己定')}；判据：${String(pick.verify || '没写').slice(0, 60)}`;
  return `\n\n【练手位】${kind}：${line}\n想试就试，不想就把它们放着；判据能机检（文件:/网址:/命令:）的可以用 skill_verify 验一下；判据写错了可以用 skill_edit 改。`;
}
