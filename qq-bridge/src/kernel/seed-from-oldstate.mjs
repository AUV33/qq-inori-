// kernel/seed-from-oldstate.mjs · 旧系统真实状态 → 内核初始状态（绞杀者 P1→P2 的对账桥）。
//
// 干什么：把旧系统「此刻的状态」映射成内核 INITIAL_STATE 的标量，让影子内核从真实起点起步，
//         而不是从合成初始值（energy=0.85）起步——这样 kernel-shadow-reconcile 的偏差才真实。
// 为什么难：旧系统状态分散且部分不可靠（social-timing-service 注释确认 st.mood.energy 从没写入、恒 0.5；
//         energy/hunger/stress 来自 getSelfState()，warmth/energy 来自 inori_state.json 经 loadMoodState 读）。
//         所以这是 best-effort 映射，未知字段一律回退默认值，绝不抛错、绝不伪造。
// 输入输出：mapSelfStateToKernel({ self, mood, curiosity, sleeping }) → 内核标量子集（可被 normalizeState 合并）。
// 失败模式：缺字段 → 默认值；非有限数 → 默认；全程 clamp 到 [0,1]。
// 不做什么：只读、不写；不决定业务语义；不假设旧字段一定存在。

const clamp01 = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(1, Number(x))) : 0);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * @param {object} [old] 归一化后的旧系统状态快照
 * @param {object} [old.self]   getSelfState() 的返回值（tickSelfState 产出），含 energy/socialHunger/stress/sleeping（部分旧字段不可靠）
 * @param {object} [old.mood]   loadMoodState(cfg.socialV2.mood.file) 的返回值，含 warmth/energy
 * @param {number} [old.curiosity] 旧 curiosity.json 的 loops 条数（非 0..1 标量，粗略归一）
 * @param {boolean} [old.sleeping] 旧系统当前是否在睡
 * @returns {object} 内核标量子集
 */
export function mapSelfStateToKernel(old = {}) {
  const self = old.self && typeof old.self === 'object' ? old.self : {};
  const mood = old.mood && typeof old.mood === 'object' ? old.mood : {};
  const curiosityN = Number.isFinite(Number(old.curiosity)) ? Number(old.curiosity) : 0;
  const sleeping = !!old.sleeping || !!(self && self.sleeping);

  // 旧系统情绪唯一真源是 inori_state.json 的 energy/warmth（social-timing-service 注释确认）。
  const moodEnergy = num(mood.energy, 0.5);
  const warmth = num(mood.warmth, 0.5);
  // 旧 selfState（tickSelfState 产出）含 energy/socialHunger/stress（已知部分字段不可靠，回退保守值）。
  const energy = num(self.energy, 0.6);
  const hunger = num(self.socialHunger ?? self.hunger, 0.3);
  const stress = num(self.stress, 0.1);
  // curiosity 在旧系统是条目数组长度，粗略 /50 归一（仅用于让影子起点接近旧系统量级）。
  const curiosity = Math.min(1, curiosityN / 50);
  // sleepDebt：旧系统无独立标量，用睡眠态近似。
  const sleepDebt = sleeping ? 0.7 : 0.1;

  return {
    energy: clamp01(energy),
    sleepDebt: clamp01(sleepDebt),
    socialHunger: clamp01(hunger),
    curiosity: clamp01(curiosity),
    stress: clamp01(stress),
    valence: clamp01(warmth),
    mood: clamp01((warmth + moodEnergy) / 2),
    sleeping,
  };
}

/**
 * 从旧系统标准访问器直接取快照并映射（便于 app.mjs 一行接线）。
 * @param {object} deps
 * @param {function} [deps.loadMoodState] 旧 loadMoodState(file)
 * @param {string}   [deps.moodFile]      cfg.socialV2.mood.file
 * @param {object}   [deps.selfState]     mindGroundwork.selfState
 * @param {number}   [deps.curiosityCount] curiosity.json 的 loops 长度
 * @param {boolean}  [deps.sleeping]
 */
export function seedFromOldSystem(deps = {}) {
  let mood = null;
  try { if (typeof deps.loadMoodState === 'function') mood = deps.loadMoodState(deps.moodFile); } catch { mood = null; }
  return mapSelfStateToKernel({
    self: deps.selfState || {},
    mood: mood || {},
    curiosity: deps.curiosityCount || 0,
    sleeping: !!deps.sleeping,
  });
}
