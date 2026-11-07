// decision-context.mjs · 每轮刷新的不可变决策上下文（决策总线）
//
// 干什么：把“她此刻知道什么”收成一份结构化快照：自我、信念、生活、情绪、质量、失败、经验、
//         意图、记忆、情境。每个生产者独立、可失败；缺谁就记 missing/degraded，不阻塞决策。
// 为什么：现状生产者只把状态塞进提示词，确定性决策（门/调度/打分/表达）读不到（蓝图 G1）。
// 输入输出：纯函数；producers 是由调用方注入的惰性函数，便于测试与降级。
// 失败模式：单个 producer 抛错 → 记录 degraded，其余继续；未知 producer 忽略。
// 不做什么：不直接读文件/不做 IO/不调用模型；不做决策本身（消费者各自读）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §3.6 / §4.11 / R1

export const DECISION_CONTEXT_VERSION = 1;

export const PRODUCER_NAMES = Object.freeze([
  'self', 'belief', 'life', 'affect', 'quality', 'failures', 'lessons', 'intentions', 'memory', 'situation',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function safeCall(name, fn) {
  if (typeof fn !== 'function') return { ok: false, missing: true, value: null, error: '' };
  try {
    return { ok: true, missing: false, value: fn(), error: '' };
  } catch (error) {
    return { ok: false, missing: false, value: null, error: String(error?.message ?? error) };
  }
}

/**
 * @param {{key?:string, scene?:'private'|'group'|string, at?:number, producers?:object}} spec
 */
export function buildDecisionContext(spec = {}) {
  const key = typeof spec.key === 'string' ? spec.key : '';
  const scene = typeof spec.scene === 'string' && spec.scene ? spec.scene : (key.startsWith('group:') ? 'group' : 'private');
  const at = Number.isFinite(spec.at) ? spec.at : Date.now();
  const producers = spec.producers && typeof spec.producers === 'object' ? spec.producers : {};

  const data = {};
  const present = [];
  const missing = [];
  const degraded = [];
  for (const name of PRODUCER_NAMES) {
    const result = safeCall(name, producers[name]);
    data[name] = result.value === undefined ? null : result.value;
    if (result.missing) missing.push(name);
    else if (result.ok) present.push(name);
    else degraded.push({ name, error: result.error });
  }

  const coverage = Object.freeze({ present: Object.freeze(present), missing: Object.freeze(missing), degraded: Object.freeze(degraded) });
  return deepFreeze({
    v: DECISION_CONTEXT_VERSION,
    key,
    scene,
    at,
    ...data,
    coverage,
  });
}

export function contextSummary(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const bits = [ctx.scene || '?', ctx.key || '?'];
  if (ctx.self && typeof ctx.self === 'object') {
    if (Number.isFinite(ctx.self.energy)) bits.push('energy=' + ctx.self.energy.toFixed(2));
    if (Number.isFinite(ctx.self.socialHunger)) bits.push('social=' + ctx.self.socialHunger.toFixed(2));
  }
  if (ctx.belief && typeof ctx.belief === 'object') {
    if (Number.isFinite(ctx.belief.affinity)) bits.push('affinity=' + ctx.belief.affinity.toFixed(2));
  }
  bits.push('producers=' + ctx.coverage.present.length + '/' + PRODUCER_NAMES.length);
  if (ctx.coverage.degraded.length) bits.push('degraded=' + ctx.coverage.degraded.map((d) => d.name).join(','));
  return '[' + bits.join(' ') + ']';
}

/** 供 LifeLog 落盘的最小行（不写全量状态，避免日志膨胀）。 */
export function contextEventRow(ctx) {
  return {
    type: 'decision.context',
    key: ctx?.key || '',
    payload: {
      scene: ctx?.scene || '',
      coverage: ctx?.coverage || null,
      self: ctx?.self ? { energy: ctx.self.energy, socialHunger: ctx.self.socialHunger, stress: ctx.self.stress } : null,
      belief: ctx?.belief ? { id: ctx.belief.id, affinity: ctx.belief.affinity, trust: ctx.belief.trust } : null,
    },
  };
}

export function contextFingerprint(ctx) {
  try {
    return JSON.stringify(ctx);
  } catch {
    return '';
  }
}
