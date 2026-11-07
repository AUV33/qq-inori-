// life-authority.mjs · 宪章 C6 / S4b：状态字段的唯一写者矩阵（纯函数）
//
// 干什么：把"哪个模块拥有哪个字段"写成数据；提供 checkWrite / authorityReport。
// 为什么：kernel 与 state-hub 都写 energy/valence 等标量，双写会让 replay 与真实态漂移。
//         切主前必须先把双写字段列清楚，并让新代码在写入前能查"我有没有这个字段的写权"。
// 输入输出：纯常量 + 纯函数；不读写盘。
// 失败模式：未知字段返回 not-covered（交给上层），不误杀。
// 不做什么：不自动迁移字段、不改任何状态；收敛动作属于 S4b 后续。

export const LIFE_AUTHORITY_VERSION = 1;

/** 单写字段：只有 owner 可以写。dual 字段见 DUAL_FIELDS。 */
export const FIELD_OWNERS = Object.freeze({
  // kernel 独占（L1/L4/成长）
  selfTrust: 'kernel',
  attention: 'kernel',
  goals: 'kernel',
  curiosities: 'kernel',
  commitments: 'kernel',
  declined: 'kernel',
  freedomAdjustments: 'kernel',
  selfThread: 'kernel',
  trustLog: 'kernel',
  lastInitiateAt: 'kernel',
  // state-hub 独占（L1 情绪/关系）
  affect: 'state-hub',
  beliefs: 'state-hub',
  competence: 'state-hub',
  arousal: 'state-hub',
  // 不归任何一方：派生/观测
  lessons: 'lessons-ledger',
});

/**
 * 双写字段：两套状态都在写，切主前必须选单一写者。
 * 这些不是"允许双写"，而是"已知冲突、尚未收敛"——任何新功能不得再把它们写进第三处。
 */
export const DUAL_FIELDS = Object.freeze([
  'energy', 'sleepDebt', 'socialHunger', 'curiosity', 'stress', 'valence', 'mood',
]);

export const AUTHORITY_PENDING = Object.freeze([
  'energy/sleepDebt/socialHunger/curiosity/stress/valence/mood 由 kernel 与 state-hub 双写；S4b 切主前必须收敛',
  'kernel.affect（五维）与 state-hub.self.affect（六维含 curiosity 情绪）是两套情绪表示；对账里 curiosity 标 missing',
]);

/** 查写权：ok=true 表示该模块可以写该字段（dual 字段会标 dual=true，需要调用方显式决策）。 */
export function checkWrite(module, field) {
  const owner = FIELD_OWNERS[String(field)] || null;
  const dual = DUAL_FIELDS.includes(String(field));
  if (!owner && !dual) return { ok: false, reason: 'not-covered', module, field, owner: null, dual: false };
  if (dual) return { ok: true, reason: 'dual-pending-convergence', module, field, owner: null, dual: true };
  return { ok: owner === String(module), reason: owner === String(module) ? 'owner' : 'foreign-owner', module, field, owner, dual: false };
}

/** 机器可读报告：给启动日志/审计用。 */
export function authorityReport() {
  return {
    v: LIFE_AUTHORITY_VERSION,
    owners: { ...FIELD_OWNERS },
    dual: [...DUAL_FIELDS],
    pending: [...AUTHORITY_PENDING],
    dualCount: DUAL_FIELDS.length,
    singleWriterFields: Object.keys(FIELD_OWNERS).length,
  };
}
