// kernel/state.mjs · 单一状态权威：她此刻是谁，只有这一份。
//
// 干什么：定义唯一状态结构；reduce(state, event) 是状态变化的**唯一入口**；
//         replay(events) 从事件流重建任意时刻的她（事故可回放 / 自我连续性的根基）。
// 为什么：旧系统双状态根 + self-state/beliefs/lessons/affect 各自读写，
//         没有一条"她怎么变成现在这样"的证据链，也没有可回放的权威值。
// 输入输出：纯函数；时间由事件携带，不读 Date.now（离线确定性）。
// 失败模式：未知事件忽略（但事件本身已在 events.mjs 校验过）；数值一律 clamp 到 [0,1]。
// 不做什么：不持久化、不调模型、不发消息、不决定行动。
//
// 宪章落位（2026-11-05 S1）：
//   L1 状态：energy / socialHunger / curiosity / stress / valence / mood / **attention** / **selfTrust**
//   L2 欲望：**goals[]**（她立的） / **curiosities[]**（她挂心的）
//   L4 立法：**commitments[]**（她给自己立的法 + 自选罚则） / **declined[]**（她拒绝的事） /
//           **freedomAdjustments[]**（世界给她的后果，她可反驳）
//   §5.20：**selfThread**（跨 idle 的那根线：此刻在想什么）
//   C4/A6：系统不自动改 selfTrust、不自动撤销 goal；承诺兑现/食言只是事实，信任由她自己的评估事件改写。

import { isKnownEvent } from './events.mjs';

export const KERNEL_STATE_VERSION = 3;

export const INITIAL_STATE = Object.freeze({
  v: KERNEL_STATE_VERSION,
  at: 0,
  // [动力学协调] 旧值 0.65 起步 + 18h 耗尽，而社交饥饿要 30h 才到阈值 ——
  // 她会在"想找人"之前先累倒，内生驱动在物理上不可能发生。醒来即 0.85，
  // 清醒 24h 耗尽、孤独 20h 到顶、好奇 40h 到顶，保证动机发生在清醒期。
  energy: 0.85,
  sleepDebt: 0.1,
  socialHunger: 0.3,
  curiosity: 0.5,
  stress: 0.1,
  valence: 0.05,
  mood: 0.05,
  // §5.2 情绪因果：五维情绪底色（curiosity 作为驱动由标量承载，这里不重复）。
  // 全部半衰 6h；由她自己的生活事件小步抬升（0.02~0.06），禁止跳变。
  affect: Object.freeze({ joy: 0, sadness: 0, anger: 0, fear: 0, affection: 0 }),
  // §5.19：注意力是可耗竭资源（被消息/行动消耗，休息恢复），低时允许分心/走神。
  attention: 0.9,
  // §5.3：自我信任。只由她自己的 self.trust_assessed 改写（A6），承诺事实不自动拨动。
  selfTrust: 0.5,
  sleeping: false,
  ticks: 0,
  turns: 0,
  lastReflectAt: 0,
  // 最近一次主动发起的时间（用于"被忽略后先缓一缓"的冷却），0 = 从未。
  lastInitiateAt: 0,
  lessons: Object.freeze([]),
  lessonRefs: Object.freeze([]),   // 反思产物被决策引用的证据（R7「经验改变行为」可度量）
  // L2 欲望层（她自己的）
  goals: Object.freeze([]),
  curiosities: Object.freeze([]),
  // L4 立法层（只有她能写）
  commitments: Object.freeze([]),
  declined: Object.freeze([]),
  freedomAdjustments: Object.freeze([]),
  // L1/§5.20
  selfThread: Object.freeze({ thought: '', at: 0 }),
  // G1 长程规划：进行中/已结束的 plan（步骤编排状态），由 plan.* 事件改写。
  plans: Object.freeze([]),
  trustLog: Object.freeze([]),
  unread: Object.freeze([]),
  errors: 0,
});

const MAX_GOALS = 40;
const MAX_CURIOSITIES = 40;
const MAX_COMMITMENTS = 40;
const MAX_DECLINED = 50;
const MAX_FREEDOM = 30;
const MAX_TRUST_LOG = 30;
const MAX_PLANS = 20;
const MAX_TEXT = 300;

const clamp01 = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
};
const drift = (v, target, dtMs, tauMs) => {
  if (!(dtMs > 0) || !(tauMs > 0)) return v;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return clamp01(v + (target - v) * k);
};
const text = (v, n = MAX_TEXT) => String(v ?? '').trim().slice(0, n);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ── §5.2 情绪因果 ─────────────────────────────────────────────
// 五维情绪半衰 6h；事件只能小步抬升（禁止跳变）。curiosity 作为情绪维度不在此重复，
// 她的"好奇驱动"由标量 curiosity 承载——两者语义不同，混用会让"好奇"变成两个真相。
const AFFECT_HALF_LIFE_MS = 6 * 3600000;

export function decayAffect(affect, dtMs) {
  const base = affect && typeof affect === 'object' ? affect : INITIAL_STATE.affect;
  if (!(dtMs > 0)) return { ...base };
  const k = Math.pow(0.5, dtMs / AFFECT_HALF_LIFE_MS);
  return {
    joy: clamp01(base.joy * k), sadness: clamp01(base.sadness * k),
    anger: clamp01(base.anger * k), fear: clamp01(base.fear * k),
    affection: clamp01(base.affection * k),
  };
}

export function bumpAffect(affect, changes) {
  const base = affect && typeof affect === 'object' ? affect : INITIAL_STATE.affect;
  const out = { joy: clamp01(base.joy), sadness: clamp01(base.sadness), anger: clamp01(base.anger), fear: clamp01(base.fear), affection: clamp01(base.affection) };
  for (const [key, delta] of Object.entries(changes || {})) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = clamp01(out[key] + num(delta, 0));
  }
  return out;
}

/** 确定性"无由情绪"噪声：同一事件流必然得到同一结果（可 replay），范围 ±1。 */
export function moodNoise(seed, salt = 0) {
  const source = String(seed);
  let h = 2166136261 ^ Number(salt || 0);
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 2001) / 1000 - 1;
}

function pushBounded(list, item, cap, isResolved) {
  const arr = [...(Array.isArray(list) ? list : []), item];
  if (arr.length <= cap) return arr;
  // 先淘汰已了结的最旧条目，避免把仍在进行中的条目挤掉。
  // [P2-9] 每个列表的终态不同：goal=done/dropped、curiosity=closed、commitment=kept/broken。
  const resolvedFn = typeof isResolved === 'function'
    ? isResolved
    : (x) => Boolean(x && x.status && x.status !== 'active');
  const resolved = arr.findIndex((x) => resolvedFn(x));
  const dropIndex = resolved >= 0 ? resolved : 0;
  return arr.filter((_, i) => i !== dropIndex).slice(-cap);
}

function normalizeGoal(input) {
  const g = input && typeof input === 'object' ? input : {};
  const status = ['active', 'done', 'dropped'].includes(g.status) ? g.status : 'active';
  const at = Math.max(0, num(g.createdAt, num(g.at, 0)));
  return {
    id: text(g.id, 80),
    text: text(g.text),
    status,
    stale: Boolean(g.stale),
    createdAt: at,
    updatedAt: Math.max(0, num(g.updatedAt, at)),
    staleAt: g.staleAt == null ? null : Math.max(0, num(g.staleAt, 0)),
    resolvedAt: g.resolvedAt == null ? null : Math.max(0, num(g.resolvedAt, 0)),
    abandonedReason: text(g.abandonedReason, 120),
    progress: text(g.progress, 200),
  };
}

function normalizeCuriosity(input) {
  const c = input && typeof input === 'object' ? input : {};
  const status = ['open', 'closed'].includes(c.status) ? c.status : 'open';
  const at = Math.max(0, num(c.openedAt, num(c.at, 0)));
  return {
    id: text(c.id, 80),
    text: text(c.text),
    status,
    openedAt: at,
    closedAt: c.closedAt == null ? null : Math.max(0, num(c.closedAt, 0)),
    how: ['resolved', 'lost', 'declined'].includes(c.how) ? c.how : '',
  };
}

function normalizeCommitment(input) {
  const c = input && typeof input === 'object' ? input : {};
  const status = ['active', 'kept', 'broken'].includes(c.status) ? c.status : 'active';
  const at = Math.max(0, num(c.createdAt, num(c.at, 0)));
  return {
    id: text(c.id, 80),
    text: text(c.text),
    penalty: text(c.penalty, 200),
    status,
    createdAt: at,
    updatedAt: Math.max(0, num(c.updatedAt, at)),
    resolvedAt: c.resolvedAt == null ? null : Math.max(0, num(c.resolvedAt, 0)),
    brokenReason: text(c.brokenReason, 160),
  };
}

function normalizeDeclined(input) {
  const d = input && typeof input === 'object' ? input : {};
  return { target: text(d.target, 160), reason: text(d.reason, 200), at: Math.max(0, num(d.at, 0)) };
}

function normalizeFreedom(input) {
  const f = input && typeof input === 'object' ? input : {};
  return {
    kind: text(f.kind, 60),
    detail: text(f.detail, 200),
    ref: text(f.ref, 80),
    at: Math.max(0, num(f.at, 0)),
    rebutted: Boolean(f.rebutted),
    rebuttal: text(f.rebuttal, 200),
  };
}

function normalizePlan(input) {
  const p = input && typeof input === 'object' ? input : {};
  const status = ['active', 'completed', 'failed'].includes(p.status) ? p.status : 'active';
  return {
    id: text(p.id, 80),
    goalId: text(p.goalId, 80),
    text: text(p.text),
    status,
    steps: Array.isArray(p.steps)
      ? p.steps.slice(0, 50).map((s) => ({
        index: num(s.index, 0),
        intention: text(s.intention, 40),
        ok: Boolean(s.ok),
        note: text(s.note, 200),
        observation: text(s.observation, 500),
        at: num(s.at, 0),
      }))
      : [],
    currentStep: Math.max(0, num(p.currentStep, 0)),
    startedAt: num(p.startedAt, 0),
    endedAt: p.endedAt == null ? null : Math.max(0, num(p.endedAt, 0)),
    failReason: text(p.failReason, 200),
  };
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return { ...INITIAL_STATE, affect: { ...INITIAL_STATE.affect }, lessons: [], lessonRefs: [], goals: [], curiosities: [], commitments: [], declined: [], freedomAdjustments: [], trustLog: [], unread: [] };
  const base = { ...INITIAL_STATE, ...raw };
  const at = Number.isFinite(Number(base.at)) ? Number(base.at) : 0;
  return {
    ...base,
    v: KERNEL_STATE_VERSION,
    at,
    energy: clamp01(base.energy), sleepDebt: clamp01(base.sleepDebt),
    socialHunger: clamp01(base.socialHunger), curiosity: clamp01(base.curiosity),
    stress: clamp01(base.stress), valence: clamp01(base.valence), mood: clamp01(base.mood),
    affect: {
      joy: clamp01(base.affect?.joy), sadness: clamp01(base.affect?.sadness),
      anger: clamp01(base.affect?.anger), fear: clamp01(base.affect?.fear),
      affection: clamp01(base.affect?.affection),
    },
    attention: clamp01(base.attention), selfTrust: clamp01(base.selfTrust),
    sleeping: Boolean(base.sleeping),
    ticks: Math.max(0, num(base.ticks)),
    turns: Math.max(0, num(base.turns)),
    lastReflectAt: num(base.lastReflectAt),
    lastInitiateAt: Math.max(0, num(base.lastInitiateAt)),
    errors: Math.max(0, num(base.errors)),
    lessons: Array.isArray(base.lessons) ? base.lessons.slice(-30) : [],
    lessonRefs: Array.isArray(base.lessonRefs) ? base.lessonRefs.slice(-30) : [],
    goals: Array.isArray(base.goals) ? uniqueById(base.goals.map(normalizeGoal).filter((g) => g.id)).slice(-MAX_GOALS) : [],
    curiosities: Array.isArray(base.curiosities) ? uniqueById(base.curiosities.map(normalizeCuriosity).filter((c) => c.id)).slice(-MAX_CURIOSITIES) : [],
    commitments: Array.isArray(base.commitments) ? uniqueById(base.commitments.map(normalizeCommitment).filter((c) => c.id)).slice(-MAX_COMMITMENTS) : [],
    declined: Array.isArray(base.declined) ? base.declined.map(normalizeDeclined).slice(-MAX_DECLINED) : [],
    freedomAdjustments: Array.isArray(base.freedomAdjustments) ? base.freedomAdjustments.map(normalizeFreedom).slice(-MAX_FREEDOM) : [],
    plans: Array.isArray(base.plans) ? uniqueById(base.plans.map(normalizePlan).filter((x) => x.id)).slice(-MAX_PLANS) : [],
    trustLog: Array.isArray(base.trustLog)
      ? base.trustLog.filter((row) => row && typeof row === 'object').slice(-MAX_TRUST_LOG).map((row) => ({
        at: Math.max(0, num(row.at, 0)), value: clamp01(row.value), reason: text(row.reason, 160),
      }))
      : [],
    selfThread: {
      thought: text(base.selfThread?.thought, 240),
      at: Math.max(0, num(base.selfThread?.at, 0)),
    },
    unread: Array.isArray(base.unread) ? base.unread.slice(-50) : [],
  };
}

/** 时间流逝：醒着会累、孤独会涨、注意力耗尽、情绪会回落。dt 由事件间隔给出，不隐含任何定时器。 */
function advanceTime(s, dtMs) {
  if (!(dtMs > 0)) return s;
  const hours = dtMs / 3600000;
  const attentionTau = s.sleeping ? 3 * 3600000 : 10 * 3600000;
  if (s.sleeping) {
    return {
      ...s,
      energy: clamp01(s.energy + hours / 8),
      sleepDebt: clamp01(s.sleepDebt - hours / 8),
      stress: drift(s.stress, 0, dtMs, 4 * 3600000),
      attention: drift(s.attention, 1, dtMs, attentionTau),
      affect: decayAffect(s.affect, dtMs),
    };
  }
  return {
    ...s,
    energy: clamp01(s.energy - hours / 24),
    sleepDebt: clamp01(s.sleepDebt + hours / 24),
    socialHunger: clamp01(s.socialHunger + hours / 20),
    curiosity: clamp01(s.curiosity + hours / 40),
    stress: drift(s.stress, 0.05, dtMs, 6 * 3600000),
    valence: drift(s.valence, 0, dtMs, 4 * 3600000),
    mood: drift(s.mood, s.valence, dtMs, 24 * 3600000),
    attention: drift(s.attention, 1, dtMs, attentionTau),
    affect: decayAffect(s.affect, dtMs),
  };
}

function updateById(list, id, patch) {
  const wanted = String(id || '');
  return (Array.isArray(list) ? list : []).map((row) => (String(row?.id) === wanted ? { ...row, ...patch } : row));
}

/**
 * 只有在「当前状态允许」时才迁移，并告诉调用方是否真的发生了变化。
 * 终态不可回滚（done/kept/broken/closed 不能再改）；未知 id / 重复事件 → changed=false，
 * 调用方据此决定是否施加情绪副作用（P1-1/P1-2：事件重试不得产生"幻情绪"）。
 */
function transitionById(list, id, allowedFrom, patch, guard) {
  const wanted = String(id || '');
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map((row) => {
    if (changed || String(row?.id) !== wanted) return row;
    if (!allowedFrom.includes(row.status)) return row;
    if (typeof guard === 'function' && !guard(row)) return row;
    changed = true;
    return { ...row, ...patch };
  });
  return { list: next, changed };
}

/** normalize 时按 id 去重（后写覆盖先写），避免历史坏数据让 update 命中多条。 */
function uniqueById(list) {
  const byId = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    if (row && row.id) byId.set(String(row.id), row);
  }
  return [...byId.values()];
}

/**
 * 唯一 reducer。任何状态变化都必须经过这里，且只能由一条事件触发。
 * 这样 replay(events) 就是权威状态，不存在"某处偷偷改了字段"。
 */
export function reduce(state, event) {
  if (!event || !isKnownEvent(event.type)) return state;
  const s = normalizeState(state);
  // 时间单调：晚到/乱序事件不得让 state.at 倒退；否则同一段时间会被重复衰减/耗能。
  const rawAt = Number(event.at);
  const at = Number.isFinite(rawAt) ? Math.max(s.at, rawAt) : s.at;
  const dtMs = Math.max(0, at - s.at);
  const next = advanceTime(s, dtMs);
  const p = event.payload || {};
  const out = { ...next, at };

  switch (event.type) {
    case 'process.started':
    case 'life.tick':
      out.ticks += 1;
      // §5.13 无由情绪基线：不是每个心情都有因果。噪声确定、极小、可回放。
      if (!next.sleeping) {
        out.valence = clamp01(next.valence + moodNoise(`${at}:${next.ticks}:v`) * 0.004);
        out.mood = clamp01(next.mood + moodNoise(`${at}:${next.ticks}:m`, 7) * 0.003);
      }
      break;
    case 'message.received':
      out.unread = [...next.unread, { key: String(p.key || ''), at: at }].slice(-50);
      out.socialHunger = clamp01(next.socialHunger - 0.12);
      out.valence = clamp01(next.valence + 0.03);
      out.affect = bumpAffect(next.affect, { joy: 0.03, affection: 0.01 });
      out.attention = clamp01(next.attention - 0.02);
      out.turns += 1;
      break;
    case 'message.sent':
      out.socialHunger = clamp01(next.socialHunger - 0.08);
      out.energy = clamp01(next.energy - 0.01);
      out.attention = clamp01(next.attention - 0.02);
      // 她真的回过了，未回应的债就该清掉；否则 reply 意图会永远挂着，像卡住的人。
      out.unread = [];
      break;
    case 'action.taken':
      out.energy = clamp01(next.energy - 0.015);
      out.attention = clamp01(next.attention - 0.015);
      if (p.intention === 'initiate') {
        // 说出去只缓解一点；真正的"被陪够"来自 message.received（有人回应），
        // 否则她会对着空气越说越"饱"，永远学不到"没被接住就先缓一缓"。
        out.socialHunger = clamp01(next.socialHunger - 0.05);
        out.lastInitiateAt = at;
      }
      if (p.intention === 'explore') out.curiosity = clamp01(next.curiosity - 0.2);
      break;
    case 'sleep.started':
      out.sleeping = true;
      break;
    case 'sleep.ended':
      out.sleeping = false;
      break;
    case 'error.observed':
      out.errors += 1;
      out.stress = clamp01(next.stress + 0.08);
      out.affect = bumpAffect(next.affect, { anger: 0.02, fear: 0.02 });
      out.attention = clamp01(next.attention - 0.01);
      break;
    case 'lesson.formed':
      out.lessons = [...next.lessons, {
        id: String(p.id), text: String(p.text || ''), trigger: String(p.trigger || ''),
        at: at, hits: 0,
      }].slice(-30);
      break;
    case 'decision.context':
      // 经验真的被用上了：记引用、给该 lesson 加 hits（可度量的"经验改变行为"）
      if (p.usedLessonId) {
        out.lessonRefs = [...next.lessonRefs, { id: String(p.usedLessonId), at: at, intention: String(p.intention) }].slice(-30);
        out.lessons = next.lessons.map((l) => (l.id === p.usedLessonId ? { ...l, hits: (Number(l.hits) || 0) + 1 } : l));
      }
      break;
    case 'reflection.completed':
    case 'reflection.failed':
      out.lastReflectAt = at;
      break;
    case 'memory.forgotten':
      // 有限性：忘掉的东西不再影响她（lessons 也按过期淘汰）
      if (Array.isArray(p.ids) && p.ids.length) {
        const gone = new Set(p.ids.map(String));
        out.lessons = next.lessons.filter((l) => !gone.has(String(l.id)));
      }
      break;

    // ── G1 长程规划：状态只由事件改写 ──
    case 'plan.started': {
      // 同 id 重复开 plan：忽略（plan 是不可变事实，重试不产生第二条）
      if (next.plans.some((pl) => pl.id === String(p.id || ''))) break;
      const row = normalizePlan({ id: String(p.id), goalId: p.goalId, text: p.text, status: 'active', startedAt: at, steps: [], currentStep: 0 });
      out.plans = pushBounded(next.plans, row, MAX_PLANS, (x) => x.status !== 'active');
      break;
    }
    case 'plan.step': {
      const existing = (next.plans || []).find((pl) => pl.id === String(p.id || ''));
      const steps = [...(existing?.steps || []), {
        index: num(p.index, 0), intention: text(p.intention, 40), ok: Boolean(p.ok), note: text(p.note, 200), observation: text(p.observation, 500), at,
      }].slice(-50);
      out.plans = updateById(next.plans, p.id, { currentStep: Math.max(0, num(p.index, 0)) + 1, steps });
      break;
    }
    case 'plan.completed': {
      out.plans = updateById(next.plans, p.id, { status: 'completed', endedAt: at });
      break;
    }
    case 'plan.failed': {
      out.plans = updateById(next.plans, p.id, { status: 'failed', endedAt: at, failReason: text(p.reason, 200) });
      break;
    }

    // ── §5.20 跨沉默的自我线索：此刻脑子里那根线 ─────────────
    case 'self_thread.updated':
      out.selfThread = { thought: text(p.thought, 240), at: at };
      break;

    // ── §5.19 注意力资源 ─────────────────────────────────────
    case 'attention.spent':
      out.attention = clamp01(next.attention - clamp01(p.amount));
      break;
    case 'attention.restored':
      out.attention = clamp01(next.attention + clamp01(p.amount));
      break;

    // ── §5.3 selfTrust：只由她自己的评估改写（A6） ───────────
    case 'self.trust_assessed': {
      // 入口已校验；这里再守一次，防止历史坏事件把 selfTrust 静默写成 0.
      const raw = Number(p.value);
      if (typeof p.value !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) break;
      const value = clamp01(raw);
      out.selfTrust = value;
      out.trustLog = [...next.trustLog, { at: at, value, reason: text(p.reason, 160) }].slice(-MAX_TRUST_LOG);
      break;
    }

    // ── L2 目标（她立的；系统只报"陈旧"事实，不替她撤销） ─────
    case 'goal.formed': {
      const goal = normalizeGoal({
        id: String(p.id || at), text: p.text, status: 'active',
        createdAt: at, updatedAt: at,
      });
      // 同 id 全量替换：不允许旧终态与新条目并存（否则 update 会命中多条）。
      out.goals = pushBounded(next.goals.filter((g) => g.id !== goal.id), goal, MAX_GOALS, (g) => g.status !== 'active');
      break;
    }
    case 'goal.progressed': {
      const moved = transitionById(next.goals, p.id, ['active'], {
        updatedAt: at, stale: false, staleAt: null,
        progress: text(p.note || next.goals.find((g) => g.id === String(p.id))?.progress || '', 200),
      });
      if (moved.changed) out.goals = moved.list;
      break;
    }
    case 'goal.completed': {
      const moved = transitionById(next.goals, p.id, ['active'], { status: 'done', updatedAt: at, resolvedAt: at, stale: false });
      if (moved.changed) {
        out.goals = moved.list;
        // 完成自己想做的事：小步正向（§5.2「她自己的生活让她有情绪」）
        out.valence = clamp01(next.valence + 0.04);
        out.affect = bumpAffect(next.affect, { joy: 0.05 });
      }
      break;
    }
    case 'goal.abandoned': {
      const moved = transitionById(next.goals, p.id, ['active'], { status: 'dropped', updatedAt: at, resolvedAt: at, stale: false, abandonedReason: text(p.reason, 120) });
      if (moved.changed) {
        out.goals = moved.list;
        // 放下是选择：一点点失落 + 压力减；不是系统替她难过。
        out.stress = clamp01(next.stress - 0.03);
        out.affect = bumpAffect(next.affect, { sadness: 0.02 });
      }
      break;
    }
    case 'goal.stale': {
      // 只置事实标记；status 仍是 active —— 放不放弃由她决定（C4/A6）。
      // 同一目标重复 stale 不重复低落（事件重试必须幂等）。
      const marked = transitionById(next.goals, p.id, ['active'], { stale: true, staleAt: at }, (g) => !g.stale);
      if (marked.changed) {
        out.goals = marked.list;
        out.affect = bumpAffect(next.affect, { sadness: 0.03 });
      }
      break;
    }

    // ── L2 好奇 ─────────────────────────────────────────────
    case 'curiosity.opened': {
      // 同 id 重复打开：忽略第二条（事件重试幂等），不重建/不叠条。
      if (next.curiosities.some((c) => c.id === String(p.id || ''))) break;
      const row = normalizeCuriosity({ id: String(p.id || at), text: p.text, status: 'open', openedAt: at });
      out.curiosities = pushBounded(next.curiosities, row, MAX_CURIOSITIES, (c) => c.status === 'closed');
      break;
    }
    case 'curiosity.closed': {
      const how = p.how;
      if (!['resolved', 'lost', 'declined'].includes(how)) break;
      const moved = transitionById(next.curiosities, p.id, ['open'], { status: 'closed', closedAt: at, how });
      if (!moved.changed) break;
      out.curiosities = moved.list;
      // 主动查清会带来轻微正向；拖着丢掉只留下一点未完成感。都是小步（§5.2 禁跳变）。
      if (how === 'resolved') {
        out.valence = clamp01(next.valence + 0.04);
        out.curiosity = clamp01(next.curiosity + 0.03);
        out.affect = bumpAffect(next.affect, { joy: 0.05 });
      } else {
        out.stress = clamp01(next.stress + 0.02);
        out.affect = bumpAffect(next.affect, { sadness: 0.02 });
      }
      break;
    }

    // ── L4 承诺：她写法；兑现/食言是事实，信任由她自己评估 ────
    case 'commitment.made': {
      // 同 id 重复立约：忽略（承诺是不可变事实，重试不产生第二条）。
      if (next.commitments.some((c) => c.id === String(p.id || ''))) break;
      const row = normalizeCommitment({
        id: String(p.id || at), text: p.text, penalty: p.penalty,
        status: 'active', createdAt: at, updatedAt: at,
      });
      out.commitments = pushBounded(next.commitments, row, MAX_COMMITMENTS, (c) => c.status !== 'active');
      break;
    }
    case 'commitment.kept': {
      const moved = transitionById(next.commitments, p.id, ['active'], { status: 'kept', updatedAt: at, resolvedAt: at });
      if (moved.changed) {
        out.commitments = moved.list;
        out.affect = bumpAffect(next.affect, { joy: 0.03 });
      }
      break;
    }
    case 'commitment.broken': {
      const moved = transitionById(next.commitments, p.id, ['active'], { status: 'broken', updatedAt: at, resolvedAt: at, brokenReason: text(p.reason, 160) });
      if (moved.changed) {
        out.commitments = moved.list;
        // 食言让她自己难受（§5.2 小步因果），但不自动扣 selfTrust（A6）
        out.stress = clamp01(next.stress + 0.06);
        out.valence = clamp01(next.valence - 0.04);
        out.affect = bumpAffect(next.affect, { sadness: 0.05, anger: 0.02 });
      }
      break;
    }

    // ── L4 拒绝通道：记录、不重试、不惩罚、不降权 ────────────
    case 'declined':
      out.declined = [...next.declined, normalizeDeclined({ target: p.target, reason: p.reason, at: at })].slice(-MAX_DECLINED);
      // 说出「我不」之后的一点松弛：拒绝不被惩罚。
      out.stress = clamp01(next.stress - 0.02);
      break;

    // ── §4.3 世界给的后果，她可反驳（连系统的限制也能被她的立法推翻） ──
    case 'freedom.adjust': {
      const row = normalizeFreedom({ kind: p.kind, detail: p.detail, ref: p.ref, at: at });
      out.freedomAdjustments = [...next.freedomAdjustments, row].slice(-MAX_FREEDOM);
      // 被世界收紧：一点压力/不痛快；她可反驳（下一条）。
      out.stress = clamp01(next.stress + 0.02);
      out.affect = bumpAffect(next.affect, { anger: 0.01 });
      break;
    }
    case 'freedom.rebutted': {
      const ref = String(p.ref || '');
      let marked = false;
      out.freedomAdjustments = next.freedomAdjustments.map((row) => {
        if (!marked && (row.ref === ref || String(row.at) === ref)) {
          marked = true;
          return { ...row, rebutted: true, rebuttal: text(p.reason, 200) };
        }
        return row;
      });
      if (marked) {
        out.stress = clamp01(next.stress - 0.02);
        out.affect = bumpAffect(next.affect, { joy: 0.01 });
      }
      break;
    }

    default:
      break;
  }
  return normalizeState(out);
}

/** 从事件流重建状态。同一串事件必然得到同一个她 —— 确定性、可回放、可审计。 */
export function replay(events, initial = INITIAL_STATE) {
  let s = normalizeState(initial);
  for (const e of Array.isArray(events) ? events : []) s = reduce(s, e);
  return s;
}

/** 有限性：该睡就睡；太久没被用到的经验会淡去（遗忘不是删除，是不再注入）。 */
export function finiteNeeds(s, opts = {}) {
  const state = normalizeState(s);
  const idleMs = Number(opts.idleMs) || 0;
  const staleMs = Number(opts.staleMs) || 30 * 24 * 3600000;
  const goalStaleMs = Number(opts.goalStaleMs) || 14 * 24 * 3600000;
  return {
    shouldSleep: !state.sleeping && (state.energy < 0.18 || state.sleepDebt > 0.8),
    shouldWake: state.sleeping && state.energy > 0.8,
    idle: idleMs > 2 * 3600000,
    staleLessons: state.lessons.filter((l) => Number(s.at) - Number(l.at) > staleMs && (Number(l.hits) || 0) === 0),
    // 陈旧目标只是事实清单；是否放弃由她决定（不自动 drop）
    // 与 index.mjs 的 tick 判据统一用 >=，恰好在阈值当天两边不会一个报一个不报。
    staleGoals: state.goals.filter((g) => g.status === 'active' && !g.stale && state.at - Number(g.updatedAt) >= goalStaleMs),
  };
}
