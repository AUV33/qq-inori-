// belief-store.mjs · 她对人、对群的持久信念（纯函数，无 IO）
//
// 干什么：把“对人的印象”从提示词里的文本，变成可更新、可衰减、可驱动决策的结构。
// 为什么：现状关系/人物信息散在 people.json、social-graph、提示词块；不进入门/打分/表达，
//         也没有“未解之事”的生命周期，导致“记得这个人”只是语言里的。
// 输入输出：纯函数；store 进 store 出；时间由调用方传入 now。
// 失败模式：非法字段按中性值处理；未知 id 自动创建；不抛错（除根对象非法）。
// 不做什么：不读文件、不发消息、不调用模型；持久化由 StateStore 负责。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.3（信念库）

export const BELIEF_VERSION = 1;
export const NEUTRAL = Object.freeze({ trust: 0.5, affinity: 0.5, reliability: 0.5, familiarity: 0 });
export const DECAY = Object.freeze({
  trust: 30 * 24 * 3600 * 1000,
  affinity: 30 * 24 * 3600 * 1000,
  reliability: 60 * 24 * 3600 * 1000,
  familiarity: 180 * 24 * 3600 * 1000,
  topicHalfLife: 30 * 24 * 3600 * 1000,
});

const MAX_EVIDENCE = 20;
const MAX_TOPICS = 40;
const MAX_LOOPS = 40;

export function clamp01(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function clamp01Signed(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n <= -1) return -1;
  if (n >= 1) return 1;
  return n;
}

function approach(current, target, dtMs, tauMs) {
  if (!(tauMs > 0) || !(dtMs > 0)) return clamp01(current);
  const k = 1 - Math.exp(-dtMs / tauMs);
  return clamp01(clamp01(current) + (clamp01(target) - clamp01(current)) * k);
}

function decayValue(value, halfLifeMs, dtMs) {
  if (!(halfLifeMs > 0) || !(dtMs > 0)) return clamp01(value);
  return clamp01(clamp01(value) * Math.pow(0.5, dtMs / halfLifeMs));
}

function emptyPerson(id, now, kind = 'private') {
  return {
    v: BELIEF_VERSION,
    id: String(id),
    kind,
    trust: NEUTRAL.trust,
    affinity: NEUTRAL.affinity,
    reliability: NEUTRAL.reliability,
    familiarity: NEUTRAL.familiarity,
    topics: {},
    openLoops: [],
    boundaries: [],
    lastContactAt: 0,
    lastDecayAt: now || 0,
    interactionCount: 0,
    evidence: [],
  };
}

function emptyGroup(id, now) {
  return {
    v: BELIEF_VERSION,
    id: String(id),
    kind: 'group',
    acceptance: 0.5,
    mood: 0.5,
    norms: [],
    topics: {},
    lastActiveAt: 0,
    lastDecayAt: now || 0,
    evidence: [],
  };
}

function normalizeTopics(topics) {
  const out = {};
  if (!topics || typeof topics !== 'object') return out;
  const entries = Object.entries(topics)
    .filter(([key]) => typeof key === 'string' && key.length > 0)
    .slice(0, MAX_TOPICS);
  for (const [key, value] of entries) out[key] = clamp01(value);
  return out;
}

function normalizeLoops(loops) {
  if (!Array.isArray(loops)) return [];
  return loops
    .filter((row) => row && typeof row === 'object' && typeof row.topic === 'string' && row.topic.length > 0)
    .slice(-MAX_LOOPS)
    .map((row) => ({
      id: String(row.id || 'loop_' + row.topic),
      topic: String(row.topic),
      createdAt: Math.max(0, Number(row.createdAt) || 0),
      status: row.status === 'closed' ? 'closed' : 'open',
      closedAt: Math.max(0, Number(row.closedAt) || 0),
      urgency: clamp01(row.urgency),
    }));
}

function normalizePerson(person, id, now) {
  const base = emptyPerson(person?.id || id, now, person?.kind === 'group_member' ? 'group_member' : 'private');
  if (!person || typeof person !== 'object') return base;
  return {
    ...base,
    trust: clamp01(person.trust),
    affinity: clamp01(person.affinity),
    reliability: clamp01(person.reliability),
    familiarity: clamp01(person.familiarity),
    topics: normalizeTopics(person.topics),
    openLoops: normalizeLoops(person.openLoops),
    boundaries: Array.isArray(person.boundaries) ? [...new Set(person.boundaries.filter((x) => typeof x === 'string' && x))].slice(0, 20) : [],
    lastContactAt: Math.max(0, Number(person.lastContactAt) || 0),
    lastDecayAt: Math.max(0, Number(person.lastDecayAt) || Number(person.lastContactAt) || now || 0),
    interactionCount: Math.max(0, Math.floor(Number(person.interactionCount) || 0)),
    evidence: Array.isArray(person.evidence) ? person.evidence.filter((x) => x && typeof x === 'object').slice(-MAX_EVIDENCE) : [],
  };
}

function normalizeGroup(group, id, now) {
  const base = emptyGroup(group?.id || id, now);
  if (!group || typeof group !== 'object') return base;
  return {
    ...base,
    acceptance: clamp01(group.acceptance),
    mood: clamp01(group.mood),
    norms: Array.isArray(group.norms) ? [...new Set(group.norms.filter((x) => typeof x === 'string' && x))].slice(0, 30) : [],
    topics: normalizeTopics(group.topics),
    lastActiveAt: Math.max(0, Number(group.lastActiveAt) || 0),
    lastDecayAt: Math.max(0, Number(group.lastDecayAt) || now || 0),
    evidence: Array.isArray(group.evidence) ? group.evidence.filter((x) => x && typeof x === 'object').slice(-MAX_EVIDENCE) : [],
  };
}

export function createBeliefStore(init = {}) {
  const now = Math.max(0, Number(init?.now) || 0);
  const store = {
    v: BELIEF_VERSION,
    at: now,
    people: {},
    groups: {},
  };
  if (init?.people && typeof init.people === 'object') {
    for (const [id, person] of Object.entries(init.people)) store.people[id] = normalizePerson(person, id, now);
  }
  if (init?.groups && typeof init.groups === 'object') {
    for (const [id, group] of Object.entries(init.groups)) store.groups[id] = normalizeGroup(group, id, now);
  }
  return store;
}

export function normalizeBeliefStore(store) {
  if (!store || typeof store !== 'object') return createBeliefStore();
  return createBeliefStore({ now: store.at, people: store.people, groups: store.groups });
}

export function getPerson(store, id, opts = {}) {
  const s = normalizeBeliefStore(store);
  const key = String(id);
  const now = Math.max(0, Number(opts.now) || s.at || Date.now());
  return s.people[key] ? normalizePerson(s.people[key], key, now) : emptyPerson(key, now);
}

export function getGroup(store, id, opts = {}) {
  const s = normalizeBeliefStore(store);
  const key = String(id);
  const now = Math.max(0, Number(opts.now) || s.at || Date.now());
  return s.groups[key] ? normalizeGroup(s.groups[key], key, now) : emptyGroup(key, now);
}

/**
 * 观察一个人：更新信任/亲近/熟悉/可靠、话题、未解之事、边界。
 * @param {object} store
 * @param {string} id
 * @param {{valence?:number, reliability?:number, intensity?:number, topics?:string[]|object,
 *          openLoop?:string|{topic:string, urgency?:number}, closeLoop?:string|{id?:string, topic?:string},
 *          boundary?:string, contact?:boolean, source?:string}} observation
 * @param {{now?:number}} opts
 */
export function observePerson(store, id, observation = {}, opts = {}) {
  const s = normalizeBeliefStore(store);
  const key = String(id);
  const now = Math.max(0, Number(opts.now) || s.at || Date.now());
  const prev = s.people[key] ? normalizePerson(s.people[key], key, now) : emptyPerson(key, now);
  const obs = observation && typeof observation === 'object' ? observation : {};
  const valence = clamp01Signed(obs.valence);
  const reliability = obs.reliability === undefined ? 0.5 : clamp01(obs.reliability);
  const intensity = obs.intensity === undefined ? 1 : clamp01(obs.intensity);

  const trustDelta = Math.max(-0.08, Math.min(0.08, valence * reliability * 0.06 * intensity));
  const affinityDelta = Math.max(-0.12, Math.min(0.12, valence * 0.10 * intensity));
  const next = {
    ...prev,
    trust: clamp01(prev.trust + trustDelta),
    affinity: clamp01(prev.affinity + affinityDelta),
    familiarity: clamp01(prev.familiarity + (1 - prev.familiarity) * (0.03 + 0.05 * reliability) * intensity),
    reliability: clamp01(prev.reliability + (reliability - prev.reliability) * 0.1),
    topics: { ...prev.topics },
    openLoops: [...prev.openLoops],
    boundaries: [...prev.boundaries],
    lastContactAt: obs.contact === false ? prev.lastContactAt : now,
    lastDecayAt: now,
    interactionCount: obs.contact === false ? prev.interactionCount : prev.interactionCount + 1,
    evidence: [...prev.evidence, { at: now, valence, reliability, intensity, source: typeof obs.source === 'string' ? obs.source : '' }].slice(-MAX_EVIDENCE),
  };

  if (Array.isArray(obs.topics)) {
    for (const topic of obs.topics) {
      if (typeof topic === 'string' && topic) next.topics[topic] = clamp01((next.topics[topic] || 0) + 0.15 * intensity);
    }
  } else if (obs.topics && typeof obs.topics === 'object') {
    for (const [topic, gain] of Object.entries(obs.topics)) {
      if (topic) next.topics[topic] = clamp01((next.topics[topic] || 0) + 0.15 * intensity * clamp01(gain));
    }
  }

  if (obs.openLoop) {
    const topic = typeof obs.openLoop === 'string' ? obs.openLoop : obs.openLoop?.topic;
    if (topic && !next.openLoops.some((loop) => loop.status === 'open' && loop.topic === topic)) {
      next.openLoops.push({
        id: 'loop_' + Buffer.from(String(topic)).toString('hex').slice(0, 16) + '_' + now,
        topic: String(topic),
        createdAt: now,
        status: 'open',
        closedAt: 0,
        urgency: typeof obs.openLoop === 'object' ? clamp01(obs.openLoop?.urgency) : 0.5,
      });
    }
  }

  if (obs.closeLoop) {
    const targetId = typeof obs.closeLoop === 'string' ? '' : String(obs.closeLoop?.id || '');
    const targetTopic = typeof obs.closeLoop === 'string' ? obs.closeLoop : String(obs.closeLoop?.topic || '');
    next.openLoops = next.openLoops.map((loop) => {
      if (loop.status !== 'open') return loop;
      const hit = (targetId && loop.id === targetId) || (targetTopic && loop.topic === targetTopic);
      return hit ? { ...loop, status: 'closed', closedAt: now } : loop;
    });
  }

  if (typeof obs.boundary === 'string' && obs.boundary && !next.boundaries.includes(obs.boundary)) {
    next.boundaries.push(obs.boundary);
    next.boundaries = next.boundaries.slice(-20);
  }

  next.openLoops = next.openLoops.slice(-MAX_LOOPS);
  const topicEntries = Object.entries(next.topics).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOPICS);
  next.topics = Object.fromEntries(topicEntries);

  return normalizeBeliefStore({
    ...s,
    at: Math.max(s.at, now),
    people: { ...s.people, [key]: normalizePerson(next, key, now) },
  });
}

/**
 * 按真实 elapsed 衰减所有信念（向中性回归）。
 * @param {object} store
 * @param {{now?:number}} opts
 */
export function decayBeliefs(store, opts = {}) {
  const s = normalizeBeliefStore(store);
  const now = Math.max(0, Number(opts.now) || s.at || Date.now());
  const people = {};
  for (const [key, raw] of Object.entries(s.people)) {
    const p = normalizePerson(raw, key, now);
    const dt = Math.max(0, now - p.lastDecayAt);
    if (dt === 0) { people[key] = p; continue; }
    const topics = {};
    for (const [topic, value] of Object.entries(p.topics)) topics[topic] = decayValue(value, DECAY.topicHalfLife, dt);
    people[key] = normalizePerson({
      ...p,
      trust: approach(p.trust, NEUTRAL.trust, dt, DECAY.trust),
      affinity: approach(p.affinity, NEUTRAL.affinity, dt, DECAY.affinity),
      reliability: approach(p.reliability, NEUTRAL.reliability, dt, DECAY.reliability),
      familiarity: approach(p.familiarity, 0, dt, DECAY.familiarity),
      topics,
      lastDecayAt: now,
    }, key, now);
  }
  return normalizeBeliefStore({ ...s, at: Math.max(s.at, now), people });
}

/** 关系权重：注意/记忆/表达用（0..1）。 */
export function relationshipWeight(person) {
  const p = normalizePerson(person, person?.id || 'unknown', 0);
  return clamp01(0.5 * p.affinity + 0.3 * p.trust + 0.2 * p.familiarity);
}

/** 未解之事视图：带年龄，按 urgency × 年龄排序。 */
export function openLoopsOf(store, id, opts = {}) {
  const now = Math.max(0, Number(opts.now) || 0);
  const p = getPerson(store, id, { now });
  return p.openLoops
    .filter((loop) => loop.status === 'open')
    .map((loop) => ({ ...loop, ageDays: now > 0 && loop.createdAt > 0 ? (now - loop.createdAt) / 86400000 : 0 }))
    .sort((a, b) => (b.urgency + b.ageDays / 30) - (a.urgency + a.ageDays / 30));
}

export function closeOpenLoop(store, id, target, opts = {}) {
  return observePerson(store, id, { closeLoop: target, contact: false }, opts);
}

export function observeGroup(store, gid, observation = {}, opts = {}) {
  const s = normalizeBeliefStore(store);
  const key = String(gid);
  const now = Math.max(0, Number(opts.now) || s.at || Date.now());
  const prev = s.groups[key] ? normalizeGroup(s.groups[key], key, now) : emptyGroup(key, now);
  const obs = observation && typeof observation === 'object' ? observation : {};
  const topics = { ...prev.topics };
  if (Array.isArray(obs.topics)) {
    for (const topic of obs.topics) if (typeof topic === 'string' && topic) topics[topic] = clamp01((topics[topic] || 0) + 0.15);
  }
  const next = normalizeGroup({
    ...prev,
    acceptance: obs.acceptance === undefined ? prev.acceptance : clamp01(prev.acceptance + (clamp01(obs.acceptance) - prev.acceptance) * 0.15),
    mood: obs.mood === undefined ? prev.mood : clamp01(prev.mood + (clamp01(obs.mood) - prev.mood) * 0.2),
    norms: [...prev.norms, ...(Array.isArray(obs.norms) ? obs.norms : [])],
    topics,
    lastActiveAt: obs.active === false ? prev.lastActiveAt : now,
    lastDecayAt: now,
    evidence: [...prev.evidence, { at: now, acceptance: obs.acceptance, mood: obs.mood, source: obs.source || '' }].slice(-MAX_EVIDENCE),
  }, key, now);
  return normalizeBeliefStore({ ...s, at: Math.max(s.at, now), groups: { ...s.groups, [key]: next } });
}

/** 隐私：群上下文只拿安全视图（不含边界与证据）。 */
export function safePersonView(person) {
  const p = normalizePerson(person, person?.id || 'unknown', 0);
  return {
    v: p.v,
    id: p.id,
    kind: p.kind,
    trust: p.trust,
    affinity: p.affinity,
    familiarity: p.familiarity,
    topics: p.topics,
    openLoops: p.openLoops.filter((loop) => loop.status === 'open').map((loop) => ({ topic: loop.topic, createdAt: loop.createdAt })),
  };
}

export function snapshotBeliefStore(store) {
  return JSON.parse(JSON.stringify(normalizeBeliefStore(store)));
}

export function restoreBeliefStore(snapshot) {
  return normalizeBeliefStore(snapshot);
}
