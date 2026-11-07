// kernel-state-overlay.mjs · S4b-2：双写标量的读取收敛（state-hub 单写，kernel 只覆盖读视图）
//
// 干什么：内核每次 tick 前，把自己的状态与 state-hub 的 self 叠加——7 个双写标量
//         （energy/sleepDebt/socialHunger/curiosity/stress/valence/mood）以 hub 为准，
//         时间戳也取 hub 的 at（避免 kernel 与 hub 各推进一次时间造成双倍衰减）。
// 为什么：S4b-1 已承认 7 个双写字段；切主前必须至少让"读"收敛到一个作者。
//         写收敛（kernel 行为是否回写 hub）是 S4b-3，不在本模块假装完成。
// 输入输出：纯函数；缺 own/hub 时原样返回 own（不伪造）。
// 失败模式：字段非有限数时跳过该字段；不抛错。
// 不做什么：不写盘、不改 hub、不迁移字段；kernel 本 tick 里对这些字段的临时修改仍是"推测值"。

import { DUAL_FIELDS } from './life-authority.mjs';

export const KERNEL_OVERLAY_VERSION = 1;

/**
 * @param {object|null} ownState kernel-state.json 的形状
 * @param {object|null} hubSnapshot state-hub.json（{at, self:{...}}）或 self 本身
 * @returns {object|null}
 */
export function overlayDualFields(ownState, hubSnapshot) {
  if (!ownState || typeof ownState !== 'object') return ownState;
  const hubSelf = hubSnapshot && typeof hubSnapshot === 'object' && hubSnapshot.self && typeof hubSnapshot.self === 'object'
    ? hubSnapshot.self
    : (hubSnapshot && typeof hubSnapshot === 'object' ? hubSnapshot : null);
  if (!hubSelf) return ownState;
  const merged = { ...ownState };
  for (const field of DUAL_FIELDS) {
    const value = Number(hubSelf[field]);
    if (Number.isFinite(value)) merged[field] = value;
  }
  const hubAt = Number(hubSnapshot && hubSnapshot.at);
  if (Number.isFinite(hubAt) && hubAt > 0) merged.at = hubAt;
  merged.dualSource = 'state-hub';
  return merged;
}

export function overlayReport(ownState, hubSnapshot) {
  const merged = overlayDualFields(ownState, hubSnapshot);
  return {
    v: KERNEL_OVERLAY_VERSION,
    applied: merged !== ownState,
    source: merged && merged.dualSource === 'state-hub' ? 'state-hub' : 'kernel',
    fields: [...DUAL_FIELDS],
  };
}
