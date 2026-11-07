// kernel/events.mjs · 唯一事件契约表：她这一生里允许发生什么，只在这里定义一次。
//
// 干什么：把所有事件类型、产生阶段、消费阶段、必需字段收敛成一张表；提供 assertEvent
//         （写入前校验）与 auditEventContracts（机检"孤儿类型"）。
// 为什么：旧系统事件名是散落的字符串常量，消费端硬编码，于是出现 `error.observed`
//         只被消费却没人写、`reflection.completed` 长期没有生产者、`sleep.ended` 没人读。
//         指标因此恒为 no-data —— 不是没数据，是契约断了。契约必须能被机器审计。
// 输入输出：纯函数，零依赖；assertEvent 返回规范化事件或抛错。
// 失败模式：未知类型、缺必需字段一律抛错（宁可暴露，不要静默丢事件）。
// 不做什么：不做持久化、不决定业务语义、不替消费方解释事件。

export const KERNEL_EVENTS_VERSION = 1;

/** 单心跳的六个阶段。事件只能由其中一个阶段产生。 */
export const PHASES = Object.freeze(['sense', 'state', 'decide', 'act', 'memory', 'reflect']);

/**
 * 事件契约：phase = 产生阶段；consumers = 会读它的阶段；required = payload 必需字段。
 * consumers 非空是硬要求：没有消费者的事件等于往虚空里写，正是旧系统的病。
 */
export const EVENT_CONTRACTS = Object.freeze({
  'process.started': { phase: 'state', consumers: ['state', 'reflect'], required: [] },
  'life.tick': { phase: 'state', consumers: ['state', 'reflect'], required: ['at'] },
  'message.received': { phase: 'sense', consumers: ['state', 'decide', 'reflect'], required: ['key'] },
  'message.sent': { phase: 'act', consumers: ['state', 'memory', 'reflect'], required: ['key'] },
  'decision.context': { phase: 'decide', consumers: ['decide', 'reflect'], required: ['intention'] },
  'intention.shadow': { phase: 'decide', consumers: ['decide', 'reflect'], required: ['selected'] },
  'action.taken': { phase: 'act', consumers: ['memory', 'reflect'], required: ['intention'] },
  'sleep.started': { phase: 'state', consumers: ['state', 'reflect'], required: [] },
  'sleep.ended': { phase: 'state', consumers: ['state', 'reflect'], required: [] },
  'error.observed': { phase: 'sense', consumers: ['state', 'reflect'], required: ['source'] },
  'memory.consolidated': { phase: 'memory', consumers: ['state', 'reflect'], required: [] },
  'memory.forgotten': { phase: 'memory', consumers: ['state', 'reflect'], required: [] },
  // [闭环关键] 反思产物必须被决策阶段消费，否则"想过的事"永远进不了下一次行为。
  'lesson.formed': { phase: 'reflect', consumers: ['state', 'decide', 'reflect'], required: ['id'] },
  'reflection.completed': { phase: 'reflect', consumers: ['state', 'reflect'], required: [] },
  'reflection.failed': { phase: 'reflect', consumers: ['state', 'reflect'], required: ['reason'] },

  // ── L2 欲望层：目标与好奇。目标由她自己立（C4），系统只记录 / 报告陈旧事实 ──
  'goal.formed': { phase: 'decide', consumers: ['state', 'decide', 'reflect'], required: ['id', 'text'] },
  'goal.progressed': { phase: 'act', consumers: ['state', 'decide', 'reflect'], required: ['id'] },
  'goal.completed': { phase: 'decide', consumers: ['state', 'reflect'], required: ['id'] },
  'goal.abandoned': { phase: 'decide', consumers: ['state', 'reflect'], required: ['id', 'reason'] },
  // 陈旧是"世界给的事实"，不是系统替她撤销目标（C4/A6）：只置 stale 标记，状态仍是 active。
  'goal.stale': { phase: 'state', consumers: ['state', 'decide', 'reflect'], required: ['id'] },
  'curiosity.opened': { phase: 'decide', consumers: ['state', 'decide', 'reflect'], required: ['id', 'text'] },
  'curiosity.closed': { phase: 'decide', consumers: ['state', 'decide', 'reflect'], required: ['id', 'how'] },

  // ── L4 立法层：承诺、拒绝、自由调整。承诺与拒绝只有她能写，系统只执行她自选的罚则 ──
  'commitment.made': { phase: 'decide', consumers: ['state', 'decide', 'reflect'], required: ['id', 'text'] },
  'commitment.kept': { phase: 'act', consumers: ['state', 'reflect', 'decide'], required: ['id'] },
  'commitment.broken': { phase: 'act', consumers: ['state', 'reflect', 'decide'], required: ['id', 'reason'] },
  'declined': { phase: 'decide', consumers: ['state', 'reflect'], required: ['target', 'reason'] },
  'freedom.adjust': { phase: 'state', consumers: ['state', 'reflect'], required: ['kind', 'detail'] },
  'freedom.rebutted': { phase: 'reflect', consumers: ['state', 'reflect'], required: ['ref', 'reason'] },

  // ── G1 长程规划层：任务的步骤编排与执行闭环 ──
  // plan 由 decide 触发（存在需推进的 activeGoal 时）；真实多步执行在 DSH 会话层（act 端口之外的循环），
  // 内核只负责 plan 状态的事件溯源（可回放/可观测），不替执行侧决定步骤内容。
  'plan.started':   { phase: 'decide', consumers: ['state', 'decide', 'reflect'], required: ['id', 'goalId', 'text'] },
  'plan.step':      { phase: 'act',    consumers: ['state', 'reflect'],           required: ['id', 'index', 'intention', 'ok'] },
  'plan.completed': { phase: 'act',    consumers: ['state', 'decide', 'reflect'], required: ['id'] },
  'plan.failed':    { phase: 'act',    consumers: ['state', 'decide', 'reflect'], required: ['id', 'reason'] },

  // ── L1 状态层：自我信任与注意力。selfTrust 只由她自己的评估事件改写（A6） ──
  'self.trust_assessed': { phase: 'reflect', consumers: ['state', 'decide', 'reflect'], required: ['value', 'reason'] },
  'self_thread.updated': { phase: 'reflect', consumers: ['state', 'decide', 'reflect'], required: ['thought'] },
  'attention.spent': { phase: 'act', consumers: ['state', 'decide'], required: ['amount', 'reason'] },
  'attention.restored': { phase: 'state', consumers: ['state', 'decide'], required: ['amount', 'reason'] },
});

/**
 * payload 字段契约：类型 / 数值区间 / 枚举 / 最大长度。
 * 这是 C4/A6 唯一写入闸门的一部分——selfTrust 的 0..1、curiosity 的 how 枚举、
 * attention 的 amount 都必须在入口被拒绝，而不是在 reducer 里静默 clamp 成 0/1。
 * 未声明的额外字段允许（向前兼容），但声明的字段必须严格匹配。
 */
export const PAYLOAD_FIELDS = Object.freeze({
  'life.tick': { at: { type: 'number' } },
  'message.received': { key: { type: 'string', maxLength: 200 } },
  'message.sent': { key: { type: 'string', maxLength: 200 } },
  'decision.context': { intention: { type: 'string' }, usedLessonId: { type: 'string' }, reason: { type: 'string' } },
  'intention.shadow': { selected: { type: 'string' } },
  'action.taken': { intention: { type: 'string' }, ok: { type: 'boolean' } },
  'error.observed': { source: { type: 'string' } },
  'memory.forgotten': { ids: { type: 'array' } },
  'memory.consolidated': { count: { type: 'number', min: 0 } },
  'lesson.formed': { id: { type: 'string' }, text: { type: 'string' }, trigger: { type: 'string' } },
  'reflection.failed': { reason: { type: 'string' } },
  'goal.formed': { id: { type: 'string' }, text: { type: 'string', maxLength: 300 } },
  'goal.progressed': { id: { type: 'string' }, note: { type: 'string', maxLength: 300 } },
  'goal.completed': { id: { type: 'string' } },
  'goal.abandoned': { id: { type: 'string' }, reason: { type: 'string', maxLength: 300 } },
  'goal.stale': { id: { type: 'string' } },
  'curiosity.opened': { id: { type: 'string' }, text: { type: 'string', maxLength: 300 } },
  'curiosity.closed': { id: { type: 'string' }, how: { type: 'enum', values: ['resolved', 'lost', 'declined'] } },
  'commitment.made': { id: { type: 'string' }, text: { type: 'string', maxLength: 300 }, penalty: { type: 'string', maxLength: 200 } },
  'commitment.kept': { id: { type: 'string' } },
  'commitment.broken': { id: { type: 'string' }, reason: { type: 'string', maxLength: 300 } },
  declined: { target: { type: 'string', maxLength: 160 }, reason: { type: 'string', maxLength: 300 } },
  'freedom.adjust': { kind: { type: 'string', maxLength: 60 }, detail: { type: 'string', maxLength: 300 }, ref: { type: 'string' } },
  'freedom.rebutted': { ref: { type: 'string' }, reason: { type: 'string', maxLength: 300 } },
  'plan.started': { id: { type: 'string' }, goalId: { type: 'string' }, text: { type: 'string', maxLength: 300 } },
  'plan.step': { id: { type: 'string' }, index: { type: 'number', min: 0 }, intention: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string', maxLength: 200 }, observation: { type: 'string', maxLength: 500 } },
  'plan.completed': { id: { type: 'string' } },
  'plan.failed': { id: { type: 'string' }, reason: { type: 'string', maxLength: 300 } },
  'self.trust_assessed': { value: { type: 'number', min: 0, max: 1 }, reason: { type: 'string', maxLength: 300 } },
  'self_thread.updated': { thought: { type: 'string', maxLength: 300 } },
  'attention.spent': { amount: { type: 'number', min: 0, max: 1 }, reason: { type: 'string' } },
  'attention.restored': { amount: { type: 'number', min: 0, max: 1 }, reason: { type: 'string' } },
});

function assertPayloadField(type, key, value, spec) {
  const fail = (why) => { throw new Error(`event ${type} payload.${key} ${why}`); };
  if (spec.type === 'string') {
    if (typeof value !== 'string') fail('must be a string');
    if (Number.isFinite(spec.maxLength) && [...value].length > spec.maxLength) fail(`longer than ${spec.maxLength}`);
    return;
  }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a finite number');
    if (Number.isFinite(spec.min) && value < spec.min) fail(`less than ${spec.min}`);
    if (Number.isFinite(spec.max) && value > spec.max) fail(`greater than ${spec.max}`);
    return;
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') fail('must be a boolean');
    return;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    return;
  }
  if (spec.type === 'enum') {
    if (!Array.isArray(spec.values) || !spec.values.includes(value)) fail(`must be one of ${spec.values.join('/')}`);
    return;
  }
  fail(`has unknown spec type ${spec.type}`);
}

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CONTRACTS));

export function isKnownEvent(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_CONTRACTS, String(type));
}

/** 写入前的唯一闸门：未知类型 / 缺字段 / 时间非法都在入口处暴露。 */
export function assertEvent(type, payload = {}, at = Date.now()) {
  if (!isKnownEvent(type)) throw new Error(`unknown event type: ${type}`);
  const c = EVENT_CONTRACTS[type];
  const body = payload && typeof payload === 'object' ? payload : {};
  for (const key of c.required) {
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      throw new Error(`event ${type} missing required field: ${key}`);
    }
  }
  const fields = PAYLOAD_FIELDS[type] || {};
  for (const [key, spec] of Object.entries(fields)) {
    if (body[key] === undefined || body[key] === null) continue;
    assertPayloadField(type, key, body[key], spec);
  }
  const ms = Number(at);
  if (!Number.isFinite(ms)) throw new Error(`event ${type} has invalid at`);
  return {
    v: KERNEL_EVENTS_VERSION,
    type,
    at: ms,
    phase: c.phase,
    payload: { ...body },
  };
}

/**
 * 契约审计：返回所有"没有消费者 / 阶段非法 / 引用了不存在的消费阶段"的类型。
 * 由 CI/单测调用；旧系统迁移时对照此结果补齐生产者与消费者。
 */
export function auditEventContracts(contracts = EVENT_CONTRACTS) {
  const gaps = [];
  for (const [type, c] of Object.entries(contracts)) {
    if (!PHASES.includes(c.phase)) gaps.push({ type, gap: 'bad-phase', phase: c.phase });
    if (!Array.isArray(c.consumers) || c.consumers.length === 0) gaps.push({ type, gap: 'no-consumer' });
    else for (const p of c.consumers) if (!PHASES.includes(p)) gaps.push({ type, gap: 'bad-consumer', phase: p });
    if (!Array.isArray(c.required)) gaps.push({ type, gap: 'bad-required' });
  }
  return gaps;
}
