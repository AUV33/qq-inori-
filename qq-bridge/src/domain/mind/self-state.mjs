// self-state.mjs · 她的内在状态：需要、情绪、心境（纯函数，无 IO）
//
// 干什么：维护一组有界、可衰减、可被事件/评价更新的内部变量，作为决策与表达的状态源。
// 为什么：现状只有 life.json 的睡眠与六维情绪底色，缺“此刻”的统一状态，主动性只能靠定时器。
// 输入输出：纯函数接收 state，返回新 state；时间由调用方传入 now（便于假时钟测试）。
// 失败模式：非法数值按 0 处理；结构非法退化为默认；不抛错（除根对象为 null）。
// 不做什么：不读文件、不调用模型、不发消息；持久化由 StateStore/调用方负责。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.2（SelfState 与稳态）

export const SELF_STATE_VERSION = 1;

export const AFFECT_KEYS = Object.freeze(['joy', 'sadness', 'anger', 'fear', 'affection', 'curiosity']);

export const HALF_LIFE_MS = Object.freeze({
  affect: 6 * 3600 * 1000,      // 情绪底色 6h 半衰（沿用现有 emotion-vector 口径）
  valence: 4 * 3600 * 1000,
  arousal: 2 * 3600 * 1000,
  stress: 2 * 3600 * 1000,
  moodTau: 24 * 3600 * 1000,    // 心境是效价的低通，时间常数 24h
});

export const AWAKE_DRAIN_MS = 18 * 3600 * 1000;   // 醒着 18h 从满精力耗到 0
export const SLEEP_RECOVER_MS = 2 * 3600 * 1000;  // 睡眠 2h 恢复约 63%
export const SLEEP_DEBT_RECOVER_MS = 8 * 3600 * 1000;
export const SOCIAL_HUNGER_MS = 30 * 3600 * 1000;
export const CURIOSITY_MS = 60 * 3600 * 1000;

export const DEFAULT_SELF_STATE = Object.freeze({
  v: SELF_STATE_VERSION,
  at: 0,
  energy: 0.6,
  sleepDebt: 0.1,
  socialHunger: 0.3,
  curiosity: 0.5,
  competence: 0.5,
  stress: 0.1,
  valence: 0.05,
  arousal: 0.35,
  mood: 0.05,
  affect: Object.freeze({ joy: 0, sadness: 0, anger: 0, fear: 0, affection: 0, curiosity: 0 }),
  evidence: Object.freeze([]),
});

const MAX_EVIDENCE = 20;

function toNum(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp01(value) {
  const n = toNum(value, 0);
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function clamp(value, lo, hi) {
  const n = toNum(value, lo);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function decay(value, halfLifeMs, dtMs) {
  if (!(halfLifeMs > 0) || !(dtMs > 0)) return clamp01(value);
  return clamp01(clamp01(value) * Math.pow(0.5, dtMs / halfLifeMs));
}

function approach(current, target, dtMs, tauMs) {
  if (!(tauMs > 0) || !(dtMs > 0)) return clamp01(current);
  const k = 1 - Math.exp(-dtMs / tauMs);
  return clamp01(clamp01(current) + (clamp01(target) - clamp01(current)) * k);
}

export function createSelfState(init = {}) {
  const base = {
    ...DEFAULT_SELF_STATE,
    ...(init && typeof init === 'object' ? init : {}),
    affect: { ...DEFAULT_SELF_STATE.affect, ...(init?.affect && typeof init.affect === 'object' ? init.affect : {}) },
  };
  return normalizeSelfState(base);
}

export function normalizeSelfState(state) {
  if (!state || typeof state !== 'object') return createSelfState();
  const affect = {};
  for (const key of AFFECT_KEYS) affect[key] = clamp01(state.affect?.[key]);
  return {
    v: SELF_STATE_VERSION,
    at: Math.max(0, toNum(state.at, 0)),
    energy: clamp01(state.energy),
    sleepDebt: clamp01(state.sleepDebt),
    socialHunger: clamp01(state.socialHunger),
    curiosity: clamp01(state.curiosity),
    competence: clamp01(state.competence),
    stress: clamp01(state.stress),
    valence: clamp01(state.valence),
    arousal: clamp01(state.arousal),
    mood: clamp01(state.mood),
    affect,
    evidence: Array.isArray(state.evidence)
      ? state.evidence.filter((row) => row && typeof row === 'object').slice(-MAX_EVIDENCE)
      : [],
  };
}

/**
 * 时间推进：所有衰减/累积都按真实 elapsed 计算。
 * @param {object} state
 * @param {{now:number, sleeping?:boolean, activity?:'idle'|'social'|'work'|'play'}} opts
 */
export function tickSelfState(state, opts = {}) {
  const s = normalizeSelfState(state);
  const now = Math.max(s.at, toNum(opts.now, s.at));
  const dt = Math.max(0, now - s.at);
  if (dt === 0) return { ...s, at: now };
  const sleeping = Boolean(opts.sleeping);
  const activity = typeof opts.activity === 'string' ? opts.activity : 'idle';

  let energy = s.energy;
  let sleepDebt = s.sleepDebt;
  if (sleeping) {
    energy = approach(energy, 0.95, dt, SLEEP_RECOVER_MS);
    sleepDebt = clamp01(sleepDebt - dt / SLEEP_DEBT_RECOVER_MS);
  } else {
    energy = clamp01(energy - dt / AWAKE_DRAIN_MS);
    sleepDebt = clamp01(sleepDebt + (dt / (24 * 3600 * 1000)) * (1 - energy) * 0.5);
  }

  const feedRate = sleeping ? 0.25 : activity === 'social' ? 0.45 : 1;
  const socialHunger = clamp01(s.socialHunger + (dt / SOCIAL_HUNGER_MS) * feedRate);
  const curiosity = clamp01(s.curiosity + (dt / CURIOSITY_MS) * (activity === 'play' ? 0.2 : 1));

  const affect = {};
  for (const key of AFFECT_KEYS) affect[key] = decay(s.affect[key], HALF_LIFE_MS.affect, dt);
  const valence = decay(s.valence, HALF_LIFE_MS.valence, dt);
  const arousal = decay(s.arousal, HALF_LIFE_MS.arousal, dt);
  const stress = decay(s.stress, HALF_LIFE_MS.stress, dt);
  const mood = approach(s.mood, valence, dt, HALF_LIFE_MS.moodTau);

  return normalizeSelfState({
    ...s,
    at: now,
    energy,
    sleepDebt,
    socialHunger,
    curiosity,
    stress,
    valence,
    arousal,
    mood,
    affect,
  });
}

/**
 * OCC 简化评价：把事件评价转成六维情绪增量 + 效价/唤醒变化。
 * @param {object} state
 * @param {{valence?:number, arousal?:number, intensity?:number, emotions?:object, source?:string, at?:number}} appraisal
 * @param {{now?:number}} opts
 */
export function applyAppraisal(state, appraisal, opts = {}) {
  const s = normalizeSelfState(state);
  const now = toNum(opts.now, toNum(appraisal?.at, s.at));
  const intensity = clamp(toNum(appraisal?.intensity, 1), 0, 1);
  const valenceDelta = clamp(toNum(appraisal?.valence, 0) * intensity * 0.3, -0.3, 0.3);
  const arousalDelta = clamp(toNum(appraisal?.arousal, 0) * intensity * 0.2, -0.2, 0.2);

  const affect = { ...s.affect };
  const emotions = appraisal?.emotions && typeof appraisal.emotions === 'object' ? appraisal.emotions : {};
  for (const key of AFFECT_KEYS) {
    const raw = toNum(emotions[key], 0) * intensity * 0.25;
    affect[key] = clamp01(s.affect[key] + clamp(raw, -0.25, 0.25));
  }

  const valence = clamp01(s.valence + valenceDelta);
  const mood = clamp01(s.mood + (valence - s.mood) * 0.15);
  const evidence = [...s.evidence, {
    at: now,
    kind: 'appraisal',
    source: typeof appraisal?.source === 'string' ? appraisal.source : '',
    valence: clamp(toNum(appraisal?.valence, 0), -1, 1),
    intensity,
  }].slice(-MAX_EVIDENCE);

  return normalizeSelfState({
    ...s,
    at: now,
    valence,
    arousal: clamp01(s.arousal + arousalDelta),
    mood,
    affect,
    evidence,
  });
}

/**
 * 事件驱动更新（便捷入口）。未识别的事件不改状态，只记 evidence。
 * @param {object} state
 * @param {{type:string, intensity?:number, source?:string}} event
 * @param {{now?:number}} opts
 */
export function applyEvent(state, event, opts = {}) {
  const s = normalizeSelfState(state);
  const now = toNum(opts.now, s.at);
  const type = typeof event?.type === 'string' ? event.type : '';
  const intensity = clamp(toNum(event?.intensity, 1), 0, 1);
  const source = typeof event?.source === 'string' ? event.source : type;
  const next = (patch) => normalizeSelfState({ ...s, ...patch, at: now, evidence: [...s.evidence, { at: now, kind: type, source, intensity }].slice(-MAX_EVIDENCE) });

  switch (type) {
    case 'praise':
    case 'success':
      return applyAppraisal(s, { valence: 0.6, arousal: 0.2, intensity, source, emotions: { joy: 0.8, affection: 0.2 } }, { now });
    case 'affection':
    case 'social_positive':
      return applyAppraisal(s, { valence: 0.5, arousal: 0.15, intensity, source, emotions: { joy: 0.4, affection: 0.9 } }, { now });
    case 'conflict':
      return applyAppraisal(s, { valence: -0.6, arousal: 0.7, intensity, source, emotions: { anger: 0.7, fear: 0.2 } }, { now });
    case 'rejection':
    case 'social_negative':
      return applyAppraisal(s, { valence: -0.5, arousal: 0.3, intensity, source, emotions: { sadness: 0.7, fear: 0.3 } }, { now });
    case 'failure':
      return normalizeSelfState({
        ...applyAppraisal(s, { valence: -0.4, arousal: 0.2, intensity, source, emotions: { sadness: 0.6 } }, { now }),
        competence: clamp01(s.competence - 0.08 * intensity),
      });
    case 'social':
      return next({ socialHunger: clamp01(s.socialHunger - 0.2 * intensity), affect: { ...s.affect, affection: clamp01(s.affect.affection + 0.1 * intensity) } });
    case 'rest':
      return next({ energy: clamp01(s.energy + 0.2 * intensity), stress: clamp01(s.stress - 0.2 * intensity) });
    case 'effort':
      return next({ energy: clamp01(s.energy - 0.15 * intensity), stress: clamp01(s.stress + 0.1 * intensity) });
    case 'learn':
      return next({ curiosity: clamp01(s.curiosity - 0.2 * intensity), competence: clamp01(s.competence + 0.08 * intensity) });
    case 'sleep_start':
      return next({});
    case 'sleep_end':
      return next({ energy: clamp01(Math.max(s.energy, 0.55)) });
    default:
      return next({});
  }
}

/** 需要缺口：供元控制器计算意图价值（0..1，越大越缺）。 */
export function needsPressure(state) {
  const s = normalizeSelfState(state);
  return {
    rest: clamp01((1 - s.energy) * 0.7 + s.sleepDebt * 0.3),
    social: s.socialHunger,
    explore: s.curiosity,
    mastery: clamp01(1 - s.competence),
    care: clamp01(s.stress),
  };
}

/** 人读摘要：用于日志与（后续）表达层。 */
export function summarizeSelfState(state) {
  const s = normalizeSelfState(state);
  const lines = [];
  if (s.energy >= 0.7) lines.push('精力充沛');
  else if (s.energy >= 0.4) lines.push('有点累');
  else lines.push('很累');
  if (s.socialHunger >= 0.65) lines.push('想找人说话');
  else if (s.socialHunger <= 0.2) lines.push('刚被陪够');
  if (s.curiosity >= 0.65) lines.push('好奇');
  if (s.stress >= 0.5) lines.push('有点紧');
  if (s.mood >= 0.6) lines.push('心情不错');
  else if (s.mood <= 0.25) lines.push('心情偏低');
  return lines.join('，');
}

export function snapshotSelfState(state) {
  const s = normalizeSelfState(state);
  return JSON.parse(JSON.stringify(s));
}

export function restoreSelfState(snapshot) {
  return normalizeSelfState(snapshot);
}
