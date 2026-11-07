// meta-controller.mjs · 意志：由需要、关系、未解之事与目标生成意图，再按价值/成本/风险选择
//
// 干什么：把“她为什么现在做这件事”变成可计算的候选与选择；替代纯概率/定时器触发（蓝图 G4）。
// 为什么：主动性若与状态无关就是噪声；世界级 agent 的自主动作必须可解释、可回归、可被主人否决。
// 输入输出：纯函数；ctx 来自 decision-context；options 注入时间/冷却/否决；返回候选与选择。
// 失败模式：字段缺失按默认值；不抛错；无候选时返回 selected=null 并给出原因。
// 不做什么：不执行动作（Executor 另做）、不调用模型、不读写文件。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.7（意志与元控制器）与 R4

export const META_CONTROLLER_VERSION = 1;

export const DEFAULT_POLICY = Object.freeze({
  threshold: 0.34,
  weights: Object.freeze({ need: 0.45, relationship: 0.2, goal: 0.15, novelty: 0.1, cost: 0.25, risk: 0.3 }),
  costs: Object.freeze({ reply: 0.15, initiate: 0.3, rest: 0.05, reflect: 0.3, explore: 0.35, repair: 0.35, consolidate: 0.15 }),
  risks: Object.freeze({ reply: 0.05, initiate: 0.25, rest: 0, reflect: 0.02, explore: 0.1, repair: 0.2, consolidate: 0 }),
  cooldowns: Object.freeze({ reply: 0, initiate: 45 * 60 * 1000, rest: 20 * 60 * 1000, reflect: 6 * 3600 * 1000, explore: 2 * 3600 * 1000, repair: 2 * 3600 * 1000, consolidate: 6 * 3600 * 1000 }),
  priority: Object.freeze(['reply', 'repair', 'rest', 'initiate', 'reflect', 'consolidate', 'explore']),
});

const HOUR = 3600 * 1000;

function clamp01(value, fallback = 0) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function relationshipOf(belief) {
  if (!belief || typeof belief !== 'object') return 0.5;
  return clamp01(0.5 * num(belief.affinity, 0.5) + 0.3 * num(belief.trust, 0.5) + 0.2 * num(belief.familiarity, 0));
}

function openLoopsOf(belief) {
  if (!belief || !Array.isArray(belief.openLoops)) return [];
  return belief.openLoops.filter((loop) => loop && loop.status === 'open');
}

/**
 * @param {object} ctx decision-context 快照
 * @param {{now?:number, directed?:boolean, unreadCount?:number, idleMs?:number, night?:boolean,
 *          cooldowns?:object, ownerVeto?:boolean, policy?:object, client?:string}} options
 */
export function selectIntention(ctx, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy && typeof options.policy === 'object' ? options.policy : {}) };
  const self = ctx?.self && typeof ctx.self === 'object' ? ctx.self : {};
  const belief = ctx?.belief && typeof ctx.belief === 'object' ? ctx.belief : null;
  const scene = ctx?.scene || (options.scene || 'private');
  const now = Number.isFinite(options.now) ? options.now : (Number.isFinite(ctx?.at) ? ctx.at : Date.now());
  const directed = Boolean(options.directed);
  const unread = Math.max(0, num(options.unreadCount, 0));
  const idleMs = Math.max(0, num(options.idleMs, 0));
  const night = Boolean(options.night);
  const cooldowns = options.cooldowns && typeof options.cooldowns === 'object' ? options.cooldowns : {};

  const energy = clamp01(self.energy, 0.6);
  const sleepDebt = clamp01(self.sleepDebt, 0);
  const socialHunger = clamp01(self.socialHunger, 0.3);
  const curiosity = clamp01(self.curiosity, 0.5);
  const stress = clamp01(self.stress, 0.1);
  const restPressure = clamp01((1 - energy) * 0.7 + sleepDebt * 0.3);
  const relationship = relationshipOf(belief);
  const loops = openLoopsOf(belief);
  const lastContactAt = Math.max(0, num(belief?.lastContactAt, 0));
  const hoursSinceContact = lastContactAt > 0 ? (now - lastContactAt) / HOUR : 99;

  const candidates = [];
  const add = (type, reason, fields = {}) => {
    if (candidates.some((c) => c.type === type)) return;
    const candidate = {
      id: type + (fields.target ? ':' + fields.target : ''),
      type,
      target: fields.target || '',
      reason,
      need: clamp01(fields.need, 0),
      expectedRelief: clamp01(fields.expectedRelief, 0),
      relationshipValue: clamp01(fields.relationshipValue, relationship),
      goalProgress: clamp01(fields.goalProgress, 0),
      novelty: clamp01(fields.novelty, 0),
      cost: clamp01(fields.cost === undefined ? policy.costs[type] : fields.cost, 0),
      risk: clamp01(fields.risk === undefined ? policy.risks[type] : fields.risk, 0),
      scene,
    };
    candidate.value = clamp01(
      policy.weights.need * candidate.expectedRelief
      + policy.weights.relationship * candidate.relationshipValue
      + policy.weights.goal * candidate.goalProgress
      + policy.weights.novelty * candidate.novelty
      - policy.weights.cost * candidate.cost
      - policy.weights.risk * candidate.risk,
      -1
    );
    candidates.push(candidate);
  };

  if (directed || unread > 0) {
    add('reply', directed ? '有人直接对她说' : '有未读在等她', {
      need: 0.9,
      expectedRelief: 0.85,
      relationshipValue: Math.max(relationship, 0.5),
      goalProgress: 0.2,
    });
  }

  const loopUrgency = loops.length ? Math.min(1, loops.length * 0.2 + Math.max(...loops.map((l) => num(l.urgency, 0.3))) * 0.5) : 0;
  if ((socialHunger >= 0.55 || loops.length > 0) && hoursSinceContact >= 6 && relationship >= 0.35) {
    add('initiate', loops.length ? '有未解之事想跟进' : '想找人说话', {
      need: Math.max(socialHunger, loopUrgency),
      expectedRelief: Math.max(socialHunger * 0.8, loopUrgency * 0.8),
      relationshipValue: relationship,
      goalProgress: loopUrgency * 0.4,
      novelty: 0.1,
      risk: scene === 'group' ? 0.3 : 0.12,
    });
  }

  if (restPressure >= 0.55 || energy <= 0.2) {
    add('rest', energy <= 0.2 ? '精力见底' : '需要休息', {
      need: restPressure,
      expectedRelief: restPressure,
      relationshipValue: 0,
      cost: 0.03,
    });
  }

  if (stress >= 0.6 && relationship >= 0.45) {
    add('repair', '关系里有紧张，想先缓和', {
      need: stress,
      expectedRelief: stress * 0.7,
      relationshipValue: relationship,
      goalProgress: 0.1,
    });
  }

  if (night || stress >= 0.7) {
    add('reflect', night ? '夜里适合整理今天' : '压力高，需要想清楚', {
      need: Math.max(night ? 0.4 : 0, stress * 0.6),
      expectedRelief: Math.max(night ? 0.45 : 0, stress * 0.6),
      cost: 0.3,
    });
  }

  if (night) {
    add('consolidate', '睡眠期巩固记忆', { need: 0.35, expectedRelief: 0.4, cost: 0.15 });
  }

  if (curiosity >= 0.6 && idleMs >= 6 * HOUR) {
    add('explore', '好奇又闲着', {
      need: curiosity,
      expectedRelief: curiosity * 0.7,
      novelty: 0.8,
      cost: 0.35,
    });
  }

  // [HOMEOSTASIS] 稳态优先：极度缺精力时，休息不应被“社交/目标”长期压住。
  // 这是 30 天模拟抓到的真实缺陷：rest 的理论价值 0.31 < 阈值 0.34，导致她永远不休息。
  if (energy <= 0.2 || restPressure >= 0.8) {
    const rest = candidates.find((c) => c.type === 'rest');
    if (rest) rest.value = Math.max(rest.value, 0.6);
  }

  const vetoed = options.ownerVeto === true;
  const available = [];
  const blocked = [];
  for (const candidate of candidates) {
    if (vetoed) { blocked.push({ type: candidate.type, why: 'ownerVeto' }); continue; }
    const CD = num(policy.cooldowns[candidate.type], 0);
    const lastAt = num(cooldowns[candidate.type]?.lastAt ?? cooldowns[candidate.type], 0);
    if (CD > 0 && lastAt > 0 && now - lastAt < CD) { blocked.push({ type: candidate.type, why: 'cooldown' }); continue; }
    // 内部维护动作（反思/巩固）不直接对社交世界产生影响，阈值下浮 25%，否则夜里永远轮不到她整理自己。
    const threshold = (candidate.type === 'reflect' || candidate.type === 'consolidate') ? policy.threshold * 0.75 : policy.threshold;
    if (candidate.value < threshold) { blocked.push({ type: candidate.type, why: 'below-threshold', value: candidate.value }); continue; }
    available.push(candidate);
  }

  available.sort((a, b) => (b.value - a.value) || (policy.priority.indexOf(a.type) - policy.priority.indexOf(b.type)));
  const selected = available[0] || null;
  const reason = selected ? selected.reason
    : vetoed ? '主人否决'
      : candidates.length === 0 ? '没有需要她做的事'
        : '候选都不过阈值或冷却中';

  return {
    v: META_CONTROLLER_VERSION,
    at: now,
    scene,
    candidates,
    blocked,
    selected,
    reason,
    policyThreshold: policy.threshold,
  };
}

/** 把意图变成可执行步骤（语义动作；Executor 负责落到工具/状态）。 */
export function planFor(intention) {
  if (!intention || typeof intention !== 'object' || !intention.type) return [];
  switch (intention.type) {
    case 'reply':
      return [{ action: 'respond', scene: intention.scene, target: intention.target || '' }];
    case 'initiate':
      return [{ action: 'open_contact', scene: intention.scene, target: intention.target || '' }];
    case 'rest':
      return [{ action: 'rest' }];
    case 'reflect':
      return [{ action: 'reflect' }];
    case 'consolidate':
      return [{ action: 'consolidate' }];
    case 'explore':
      return [{ action: 'explore' }];
    case 'repair':
      return [{ action: 'repair', target: intention.target || '' }];
    default:
      return [];
  }
}
