// state-hub.mjs · 她状态的单一写入者（SelfState + AffectField + Belief + Lessons）
// 对应蓝图 G1（状态权威单写）/ F0。组合既有纯函数模块，不另造语义；不调模型、不新增进程。
// 变更只经 apply/appraise/observe*/setBelief，落盘只经本模块（复用 state-store 原子写）。
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';
import { createStateStore } from '../shared/state-store.mjs';
import { withFileLock } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
// [LEGISLATION-VIEW] 她的三本立法账是运行时事实：state-hub 负责把它们读成"她能看见的账"，
// 而不是只在控制台写盘、聊天/反思里永远读不到（审计 P1-6）。
import {
  LEDGER_FILES, parseLedgerText, foldCommitments, commitmentFacts, foldDeclined, foldSelfTrust,
} from '../life/legislation.mjs';
// [LESSONS-VIEW] 宪章 §5.4 教训账：state-hub 现读 lessons-ledger.jsonl，按状态机折叠成她能看见的账。
import { LESSON_LEDGER_FILE, parseLedger as parseLessonsLedger, foldLessons } from './lessons-ledger.mjs';
// [KERNEL-WRITEBACK] S4b-3：内核 tick 后的双写标量提案由 state-hub 接收（hub 仍是文件写者）。
import { DUAL_FIELDS } from './life-authority.mjs';
// [IDENTITY-VIEW] 宪章 §5.9：统一身份层只读视图（账本只存摘要，不落 PII 明文）。
import { IDENTITY_LEDGER_FILE, parseIdentityLedger, foldIdentity, identitySummary, resolveIdentity } from '../social/identity-map.mjs';
// [BONDS-VIEW] 宪章 §5.9/G5：关系账本只读视图（personId 键，禁忌 + 证据链）。
import { BONDS_FILE, parseBondsLedger, foldBonds, bondFor, bondsSummary } from '../social/bonds.mjs';
// [SNAPSHOT] 宪章 G4：灾难快照（state-hub 是状态仓的读端，也提供快照入口）。
import { createSnapshot, verifySnapshot } from '../shared/state-snapshot.mjs';
// [SELF-THREAD] 宪章 §5.20：跨 idle 的连续自我（此刻在想什么）。
import { buildSelfThread } from './self-thread.mjs';
// [OWNER-MODEL] 宪章 §5.19：owner 偏好演化只读视图。
import { OWNER_MODEL_FILE, parseOwnerModelLedger, foldOwnerModel } from './owner-model.mjs';
import {
  createSelfState, normalizeSelfState, tickSelfState, applyEvent as applySelfEvent,
  applyAppraisal, needsPressure, summarizeSelfState,
} from './self-state.mjs';
import {
  EMOTION_DIMENSIONS, loadEmotionVector, saveEmotionVector,
  emotionVectorFor, observeOtherAffect, observeSelfEmotion,
} from '../leaves/inori-emotion-vector.js';
import {
  createBeliefStore, normalizeBeliefStore, observePerson, observeGroup,
  getPerson, openLoopsOf, relationshipWeight,
} from './belief-store.mjs';
import { selectIntention as selectIntentionCore, planFor } from './meta-controller.mjs';

export const STATE_HUB_VERSION = 2;
export const STATE_HUB_FILE = 'state-hub.json';
const MAX_LESSONS = 200;
const DEFAULT_MIN_FLUSH_MS = 2000;

const clamp01 = (x) => { const n = Number(x); if (!Number.isFinite(n) || n <= 0) return 0; return n >= 1 ? 1 : n; };
const text = (v) => String(v ?? '').trim();
const round3 = (n) => Number(clamp01(n).toFixed(3));

/**
 * @param {{root?:string, store?:object, now?:()=>number, log?:Function,
 *          legacySelfFile?:string, legacyBeliefFile?:string, legacyEmotionFile?:string,
 *          minFlushIntervalMs?:number}} opts
 */
export function createStateHub(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const root = typeof opts.root === 'string' ? opts.root : stateDataPath('mind');
  // [AUDIT-FIX] 与 groundwork 同源：默认接上跨进程锁；测试仍可注入 store / withLock。
  const store = opts.store && typeof opts.store.writeJson === 'function'
    ? opts.store
    : createStateStore({
      root,
      now,
      withLock: opts.withLock ?? ((file, fn) => withFileLock(file, fn, { source: 'bridge/state-hub' })),
    });

  // 三本账在同一个 mind 目录下；每次现读（3 个小文件），保证控制台刚写的她下一轮就能看见。
  function readLedgerText(name) {
    try {
      return fs.readFileSync(path.join(root, LEDGER_FILES[name]), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return '';
      throw error;
    }
  }

  /** owner 偏好只读视图：当前 topics + 历史；读失败返回 null。 */
  function getOwnerModel() {
    try {
      let text = '';
      try { text = fs.readFileSync(path.join(root, OWNER_MODEL_FILE), 'utf8'); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      const parsed = parseOwnerModelLedger(text);
      const folded = foldOwnerModel(parsed.rows, { now: now() });
      return { topics: folded.topics.slice(0, 20), anomalies: folded.anomalies.slice(-20), corrupt: parsed.corrupt };
    } catch (error) { log(`[state-hub] 读取 owner-model 失败（忽略）: ${error?.message ?? error}`); return null; }
  }

  /** 连续自我卡片：读 kernel-state + self-state，折出 thought/情绪/精力/挂念；读失败返回 null。 */
  function getSelfThread() {
    try {
      const readJson = (name) => {
        try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); } catch { return null; }
      };
      const kernelState = readJson('kernel-state.json');
      const selfState = readJson('self-state.json');
      // [SELF-ANCHOR] kernel 还没跑时 selfThread 恒空；用她最近一条真实 thoughts 兜底，
      // 让“刚才在想的那根线”不至于永远消失（stale 时渲染层会明确说隔久了）。
      let fallbackThought = '';
      let fallbackAt = 0;
      if (!String(kernelState?.selfThread?.thought ?? '').trim()) {
        try {
          const file = path.join(root, '..', 'thoughts.jsonl');
          const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
          // 只取她自己的 reflect/thought；reasoning 是工具推演摘要，不是“她在想什么”。
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            let row = null;
            try { row = JSON.parse(lines[i]); } catch { continue; }
            if (!['reflect', 'thought', 'thoughts', 'self'].includes(String(row.kind ?? ''))) continue;
            const t = String(row.text ?? '').trim().replace(/^\d{5,12}\s+/, '');
            if (!t) continue;
            fallbackThought = t.slice(0, 240);
            fallbackAt = Date.parse(String(row.at ?? '')) || Number(row.time) || 0;
            break;
          }
        } catch { /* 没有 thoughts 文件就保持空 */ }
      }
      return buildSelfThread({ kernelState, selfState, now: now(), fallbackThought, fallbackAt });
    } catch (error) {
      log(`[state-hub] 读取 self-thread 失败（忽略）: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 把 mind 目录下的关键状态打成可验证快照；返回 manifest。 */
  function snapshotTo(dest, opts = {}) {
    return createSnapshot({
      root,
      dest,
      files: ['self-state.json', 'beliefs.json', 'state-hub.json', 'kernel-state.json', IDENTITY_LEDGER_FILE, BONDS_FILE, LESSON_LEDGER_FILE],
      ...opts,
    });
  }

  function verifySnapshotAt(dir) { return verifySnapshot({ dir }); }

  /** 关系账只读视图：每人 trust/affinity/familiarity + 禁忌；读失败返回 null。 */
  function getBonds() {
    try {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, BONDS_FILE), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const parsed = parseBondsLedger(text);
      const folded = foldBonds(parsed.rows, { now: now() });
      return { summary: bondsSummary(folded), people: folded.people.slice(0, 12), anomalies: folded.anomalies.slice(-20), corrupt: parsed.corrupt };
    } catch (error) {
      log(`[state-hub] 读取关系账失败（忽略）: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 取某个人的关系（无记录返回 null）。 */
  function getBond(personId) {
    try {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, BONDS_FILE), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      return bondFor(foldBonds(parseBondsLedger(text).rows, { now: now() }), personId);
    } catch { return null; }
  }

  /** 身份账只读视图：people/links/aliases 摘要；读失败返回 null。 */
  function getIdentityMap() {
    try {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, IDENTITY_LEDGER_FILE), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const parsed = parseIdentityLedger(text);
      const folded = foldIdentity(parsed.rows, { now: now() });
      return { summary: identitySummary(folded), anomalies: folded.anomalies.slice(-20), corrupt: parsed.corrupt };
    } catch (error) {
      log(`[state-hub] 读取身份账失败（忽略）: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 解析 platform × externalId → personId（现读身份账；隐私摘要匹配）。 */
  function resolvePerson(platform, externalId) {
    try {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, IDENTITY_LEDGER_FILE), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const folded = foldIdentity(parseIdentityLedger(text).rows, { now: now() });
      return resolveIdentity(folded, platform, externalId);
    } catch { return null; }
  }

  /** 教训账只读视图：已排序（verified→active→candidate），最多 12 条。读失败返回 null。 */
  function getLessonsLedger() {
    try {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, LESSON_LEDGER_FILE), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const parsed = parseLessonsLedger(text);
      const folded = foldLessons(parsed.rows, { now: now() });
      const rank = { verified: 0, active: 1, candidate: 2, contradicted: 3, demoted: 4, expired: 5 };
      const lessons = folded.lessons.slice().sort((a, b) => (
        (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        || Number(b.pos || 0) - Number(a.pos || 0)
        || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
      )).slice(0, 12);
      return { summary: folded.summary, lessons, corrupt: parsed.corrupt, anomalies: folded.anomalies.slice(-20) };
    } catch (error) {
      log(`[state-hub] 读取教训账失败（忽略）: ${error?.message ?? error}`);
      return null;
    }
  }

  /** 立法层的只读视图：facts + 最近生效的承诺/拒绝/自评。读失败返回 null（不阻塞主流程）。 */
  function getLegislation() {
    try {
      const folded = foldCommitments(parseLedgerText(readLedgerText('commitments')).rows);
      const declined = foldDeclined(parseLedgerText(readLedgerText('declined')).rows);
      const selfTrust = foldSelfTrust(parseLedgerText(readLedgerText('selfTrust')).rows);
      return {
        facts: commitmentFacts(folded.commitments),
        commitments: folded.commitments.filter((c) => c.status === 'active').slice(-10),
        resolved: folded.commitments.filter((c) => c.status !== 'active').slice(-5),
        declined: declined.slice(-10),
        selfTrust,
        anomalies: folded.anomalies,
      };
    } catch (error) {
      log(`[state-hub] 读取立法账失败（忽略）: ${error?.message ?? error}`);
      return null;
    }
  }
  const legacySelfFile = typeof opts.legacySelfFile === 'string' ? opts.legacySelfFile : 'self-state.json';
  const legacyBeliefFile = typeof opts.legacyBeliefFile === 'string' ? opts.legacyBeliefFile : 'beliefs.json';
  const legacyEmotionFile = typeof opts.legacyEmotionFile === 'string' ? opts.legacyEmotionFile : stateDataPath('emotion-vector.json');
  // 情绪镜像：落盘时同步写回旧 emotion-vector.json，保证旧读者（情绪偏置/渲染）不掉队。
  const mirrorEmotionFile = opts.mirrorEmotionFile === false ? null
    : (typeof opts.mirrorEmotionFile === 'string' ? opts.mirrorEmotionFile : legacyEmotionFile);
  const minFlushIntervalMs = Number.isFinite(opts.minFlushIntervalMs) && opts.minFlushIntervalMs >= 0 ? opts.minFlushIntervalMs : DEFAULT_MIN_FLUSH_MS;

  let state = null;
  let dirty = false;
  let lastFlushAt = 0;

  const freshState = () => {
    const at = now();
    return {
      v: STATE_HUB_VERSION, at,
      self: createSelfState({ at }),
      affect: { version: 1, updatedAt: 0, keys: {} },
      beliefs: createBeliefStore({ now: at }),
      lessons: [],
    };
  };

  function normalize(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const at = Number(base.at) || now();
    const affect = base.affect && typeof base.affect === 'object' && base.affect.keys && typeof base.affect.keys === 'object'
      ? { version: 1, updatedAt: Number(base.affect.updatedAt) || 0, keys: base.affect.keys }
      : { version: 1, updatedAt: 0, keys: {} };
    const lessons = Array.isArray(base.lessons)
      ? base.lessons.filter((l) => l && typeof l === 'object').slice(-MAX_LESSONS).map((l) => ({
        id: text(l.id) || `${at}-${Math.random().toString(36).slice(2, 8)}`,
        text: text(l.text).slice(0, 300),
        weight: clamp01(l.weight ?? 0.5),
        at: Number(l.at) || at,
        source: text(l.source).slice(0, 60),
      })) : [];
    return {
      v: STATE_HUB_VERSION, at,
      self: normalizeSelfState(base.self || createSelfState({ at })),
      affect,
      beliefs: base.beliefs ? normalizeBeliefStore(base.beliefs) : createBeliefStore({ now: at }),
      lessons,
    };
  }

  function load() {
    const raw = store.readJson(STATE_HUB_FILE, null);
    if (raw && typeof raw === 'object') { state = normalize(raw); return state; }
    const seeded = freshState();
    const legacySelf = store.readJson(legacySelfFile, null);
    if (legacySelf && typeof legacySelf === 'object') seeded.self = normalizeSelfState(legacySelf);
    const legacyBeliefs = store.readJson(legacyBeliefFile, null);
    if (legacyBeliefs && typeof legacyBeliefs === 'object') seeded.beliefs = normalizeBeliefStore(legacyBeliefs);
    try {
      const legacyAffect = loadEmotionVector(legacyEmotionFile);
      if (legacyAffect && legacyAffect.keys && Object.keys(legacyAffect.keys).length) seeded.affect = legacyAffect;
    } catch { /* 旧情绪文件缺失/损坏不阻塞 */ }
    state = seeded;
    dirty = true;
    return state;
  }

  const ensure = () => (state || load());

  const serialize = () => ({
    v: STATE_HUB_VERSION, at: state.at, self: state.self, affect: state.affect, beliefs: state.beliefs, lessons: state.lessons,
  });

  // [CONCURRENCY] 落盘串行化：并发 flush 若各自 await 写盘，慢的旧快照可能后落、覆盖新状态。
  let flushChain = Promise.resolve();

  /** 强制原子落盘（串行；失败只记日志，不抛）。 */
  function flush() {
    ensure();
    state.at = now();
    dirty = false;
    lastFlushAt = now();
    flushChain = flushChain.then(async () => {
      try {
        // 在链内序列化：即使排队期间状态更新，也写最新值而不是调用时的旧快照。
        await store.writeJson(STATE_HUB_FILE, serialize());
        if (mirrorEmotionFile) {
          try { saveEmotionVector(state.affect, mirrorEmotionFile); } catch { /* 镜像失败不影响主落盘 */ }
        }
        return true;
      } catch (error) { dirty = true; log(`[state-hub] 持久化失败（忽略）: ${error?.message ?? error}`); return false; }
    });
    return flushChain;
  }

  /** 节流落盘（设备友好：避免每条消息 I/O）。 */
  async function maybeFlush(force = false) {
    if (!dirty) return false;
    if (!force && now() - lastFlushAt < minFlushIntervalMs) return false;
    return flush();
  }

  // ── 唯一变更入口 ──────────────────────────────────────────
  function apply(event) { const s = ensure(); s.self = applySelfEvent(s.self, event, { now: now() }); s.at = now(); dirty = true; return s.self; }
  function appraise(appraisal) { const s = ensure(); s.self = applyAppraisal(s.self, appraisal, { now: now() }); s.at = now(); dirty = true; return s.self; }
  function tick({ sleeping = false, activity = 'idle', at } = {}) {
    const s = ensure();
    const t = Number.isFinite(at) ? at : now();
    s.self = tickSelfState(s.self, { now: t, sleeping, activity });
    s.at = t; dirty = true; return s.self;
  }

  function observeAffect(key, payload = {}) {
    const s = ensure(); const k = text(key) || 'default';
    s.affect.keys[k] = observeOtherAffect(s.affect, k, { ...payload, now: now() });
    s.affect.updatedAt = now(); s.at = now(); dirty = true; return s.affect.keys[k];
  }
  function observeSelfEmotion(key, selfEmotion = {}) {
    const s = ensure(); const k = text(key) || 'default';
    s.affect.keys[k] = observeSelfEmotion(s.affect, k, selfEmotion, { now: now() });
    s.affect.updatedAt = now(); s.at = now(); dirty = true; return s.affect.keys[k];
  }
  function observePersonBelief(id, observation = {}) {
    const s = ensure(); s.beliefs = observePerson(s.beliefs, id, observation, { now: now() }); s.at = now(); dirty = true;
    return getPerson(s.beliefs, id, { now: now() });
  }
  function observeGroupBelief(gid, observation = {}) {
    const s = ensure(); s.beliefs = observeGroup(s.beliefs, gid, observation, { now: now() }); s.at = now(); dirty = true;
    return s.beliefs.groups[String(gid)] || null;
  }
  const getBelief = (id) => getPerson(ensure().beliefs, id, { now: now() });
  const openLoops = (id) => openLoopsOf(ensure().beliefs, id, { now: now() });
  const relationship = (id) => relationshipWeight(getBelief(id));

  /**
   * 接收内核 tick 后的双写标量投影（只更新 DUAL_FIELDS，不做时间推进）。
   * 这是"读收敛 + 写回收敛"的另一半：kernel 提议，hub 落盘；kernel 下次 load 再读回。
   * 并发安全：只接受 at 不早于当前 hub.at 的投影；旧投影不覆盖新状态。
   */
  function applyKernelProjection(projection, { at } = {}) {
    const s = ensure();
    const t = Number(at);
    if (!Number.isFinite(t) || t < Number(s.at)) return false;
    let changed = false;
    for (const field of DUAL_FIELDS) {
      const value = Number(projection?.[field]);
      if (!Number.isFinite(value)) continue;
      const next = clamp01(value);
      if (s.self[field] !== next) { s.self[field] = next; changed = true; }
    }
    // [AUDIT-FIX] 即使字段没变也必须推进 at：否则 kernel 下一 tick 会从旧 at 再衰减一次，
    // 与 hub 自己的 tick 形成双倍时间衰减。返回值仍表示"字段是否变化"。
    // 字段变化本身也要置 dirty：同一拍 hub.tick 已把 s.at 推到 t，t > s.at 为假，
    // 原来的写法会让这 7 个双写标量改了内存却不落盘（maybeFlush 因 !dirty 立即返回）。
    if (changed) dirty = true;
    if (t > Number(s.at)) {
      s.at = t;
      s.self.at = Math.max(Number(s.self.at) || 0, t);
      dirty = true;
    }
    return changed;
  }

  function addLesson(lesson = {}) {
    const s = ensure(); const t = text(lesson.text); if (!t) return null;
    const row = { id: text(lesson.id) || `${now()}-${Math.random().toString(36).slice(2, 8)}`, text: t.slice(0, 300), weight: clamp01(lesson.weight ?? 0.5), at: Number(lesson.at) || now(), source: text(lesson.source).slice(0, 60) };
    s.lessons = [...s.lessons, row].slice(-MAX_LESSONS); s.at = now(); dirty = true; return row;
  }
  const lessons = () => ensure().lessons.slice();

  // ── 派生 ──────────────────────────────────────────────────
  function deriveContext({ scene = 'private', target = '' } = {}) {
    const s = ensure();
    const belief = target ? getPerson(s.beliefs, target, { now: now() }) : null;
    return { self: s.self, belief, scene, at: now() };
  }
  function selectIntention(options = {}) {
    return selectIntentionCore(deriveContext({ scene: options.scene, target: options.target }), options);
  }
  const planForIntention = (intention) => planFor(intention);

  /** 回复语气（宽带宽，替代 emotionBias 的 ±0.08）。 */
  function replyTone(key) {
    const s = ensure();
    const row = emotionVectorFor(s.affect, text(key) || 'default', now());
    const pos = (row.joy + row.affection) / 2;
    const neg = (row.anger + row.sadness + row.fear) / 3;
    return {
      warmth: round3(0.5 + pos * 0.45 - neg * 0.35 + s.self.mood * 0.2),
      energy: round3(s.self.energy),
      patience: round3(1 - row.anger * 0.55 - row.fear * 0.2 - s.self.stress * 0.25),
      openness: round3(0.5 + row.curiosity * 0.45 + pos * 0.15 - neg * 0.25),
      affect: { ...row },
    };
  }

  /** 记忆显著性：情绪越强，越该被记住（供记忆写入加权）。 */
  function memorySalience(key) {
    const s = ensure();
    const row = emotionVectorFor(s.affect, text(key) || 'default', now());
    const magnitude = Math.max(...EMOTION_DIMENSIONS.map((d) => Number(row[d]) || 0));
    return { salience: round3(0.15 + magnitude * 0.7 + s.self.arousal * 0.15), magnitude: round3(magnitude) };
  }

  /** 工具/安全门（只作建议；真正的隔离在 session-policy）。 */
  function toolGate(scene) {
    const s = ensure();
    return { allowLocalTools: scene === 'private', energy: round3(s.self.energy), canInitiate: s.self.energy > 0.2 };
  }

  /** 把当前内存态镜像回旧文件（迁移期用；默认不写，避免双写者）。 */
  async function mirrorLegacy({ self = false, beliefs = false, emotion = false } = {}) {
    const s = ensure();
    if (self) await store.writeJson('self-state.json', s.self);
    if (beliefs) await store.writeJson('beliefs.json', s.beliefs);
    if (emotion) saveEmotionVector(s.affect, legacyEmotionFile);
    return true;
  }

  const snapshot = () => JSON.parse(JSON.stringify(ensure()));
  function status() {
    const s = ensure();
    return {
      v: STATE_HUB_VERSION, at: s.at, dirty,
      self: summarizeSelfState(s.self), pressure: needsPressure(s.self),
      beliefs: { people: Object.keys(s.beliefs.people).length, groups: Object.keys(s.beliefs.groups).length },
      lessons: s.lessons.length,
      legislation: getLegislation()?.facts || null,
      lessonsLedger: getLessonsLedger()?.summary || null,
      identity: getIdentityMap()?.summary || null,
      bonds: getBonds()?.summary || null,
      ownerModel: getOwnerModel()?.topics?.length || 0,
    };
  }

  return {
    v: STATE_HUB_VERSION,
    store,
    load, flush, maybeFlush,
    apply, appraise, tick,
    observeAffect, observeSelfEmotion,
    observePerson: observePersonBelief, observeGroup: observeGroupBelief,
    getBelief, openLoops, relationship,
    addLesson, lessons,
    applyKernelProjection,
    getLegislation,
    getLessonsLedger,
    getIdentityMap, resolvePerson,
    getBonds, getBond,
    snapshotTo, verifySnapshotAt, getSelfThread, getOwnerModel,
    deriveContext, selectIntention, planForIntention,
    replyTone, memorySalience, toolGate,
    mirrorLegacy, snapshot, status,
    get state() { return ensure(); },
  };
}
