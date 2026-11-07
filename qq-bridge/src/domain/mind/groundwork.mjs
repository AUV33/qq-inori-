// groundwork.mjs · 认知地基的最小落地（生命线 + 自我状态 + 信念库）
//
// 干什么：在进程启动时初始化 data/state/mind/ 与 data/logs/life-log/：
//   1) 追加 process.started 事件；2) 读/建 self-state；3) 读/建 beliefs；4) 返回启动摘要。
// 为什么：蓝图 v2 的 A1（连续性）/A2（稳态）/G2（状态无权威）/G5（时间不连续）都需要一个
//   统一的启动锚点；先落地“可读写、可回放”的地基，再接决策，不改变任何消息行为。
// 输入输出：createGroundwork({root, logRoot, now}) → { store, lifeLog, start(), snapshot() }。
// 失败模式：初始化失败由调用方 catch（不阻塞 24/7 启动）；损坏文件按默认值恢复。
// 不做什么：不发消息、不调模型、不改唤醒/发送逻辑。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.1 / §4.2 / §4.3 与 R0

import { createStateStore } from '../shared/state-store.mjs';
import { withFileLock } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { createLifeLog } from '../shared/life-log.mjs';
import { createSelfState, normalizeSelfState, tickSelfState, summarizeSelfState } from './self-state.mjs';
import fs from 'node:fs';
import { createBeliefStore, restoreBeliefStore, normalizeBeliefStore, observePerson, observeGroup } from './belief-store.mjs';
import { summarizeOffline } from './offline-narrative.mjs';
import { seedBeliefsFromPeople } from './belief-seed.mjs';
import path from 'node:path';
// [BONDS-PRODUCER] 入站接触 → 关系账本（只写 familiarity，带摘要证据；每小时每人的第一次接触）。
import { createBondsStore } from '../social/bonds.mjs';
import { personIdFor, hashExternalId } from '../social/identity-map.mjs';
// [PEOPLE-VAULT] people.json 可能是 v2 信封（加密），统一走读端。
import { readPeopleFile } from '../shared/people-vault.mjs';
// [LIFE-KERNEL] 生命内核工厂：只暴露能力，不启动心跳。宿主决定何时切换到单心跳（绞杀者第一步）。
// 内核复用本模块的 store/lifeLog 作为端口，不另造一套状态与事件流。
import { createKernel } from '../../kernel/index.mjs';
import { createHostPorts } from '../../kernel/ports.mjs';

export const GROUNDWORK_VERSION = 1;

/**
 * @param {{root:string, logRoot?:string, peopleFile?:string, now?:()=>number}} opts
 */
export function createGroundwork(opts = {}) {
  if (!opts.root || typeof opts.root !== 'string') throw new Error('groundwork: root required');
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  // [AUDIT-FIX] 接上跨进程锁：state-store 的 withLock 以前为 null，
  // updateJson 只有进程内串行，多进程写同一状态文件仍会整体互相覆盖。
  const store = createStateStore({
    root: opts.root,
    now,
    withLock: opts.withLock ?? ((file, fn) => withFileLock(file, fn, { source: 'bridge/groundwork' })),
  });
  const lifeLog = createLifeLog({ root: opts.logRoot || opts.root, clock: now });

  let selfState = null;
  let beliefs = null;
  let startedAt = 0;
  let narrativeText = '';
  let contactDirty = false;
  let contactTimer = null;
  // [BONDS-PRODUCER] 关系账：接触只改 familiarity，不改 trust/affinity（那是互动评价的事）。
  const bondsFile = typeof opts.bondsFile === 'string' ? opts.bondsFile : path.join(opts.root, 'bonds.jsonl');
  const BOND_CONTACT_MIN_MS = 60 * 60 * 1000;
  let bondsStore = null;
  const lastBondContactAt = new Map();

  function noteBondContact(rawId, at) {
    try {
      const uin = String(rawId ?? '').trim();
      if (!/^\d{5,12}$/.test(uin)) return false;
      const last = lastBondContactAt.get(uin) || 0;
      if (at - last < BOND_CONTACT_MIN_MS) return false;
      lastBondContactAt.set(uin, at);
      if (!bondsStore) bondsStore = createBondsStore({ file: bondsFile, now });
      const personId = personIdFor('qq', uin);
      const evidenceId = `contact:${hashExternalId('qq', uin)}:${at}`;
      void bondsStore.observe({ personId, dimension: 'familiarity', delta: 0.02, evidenceId, note: 'inbound-contact' }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/mind/groundwork.mjs:64'));
      return true;
    } catch { return false; }
  }

  async function flushBeliefs() {
    if (contactTimer) { clearTimeout(contactTimer); contactTimer = null; }
    if (!contactDirty || !beliefs) return false;
    contactDirty = false;
    try { await store.writeJson('beliefs.json', beliefs); return true; } catch { return false; }
  }

  /** 入站接触：只更新“认识/熟悉/最后联系”，不改信任与亲疏（那是互动评价的事）。 */
  function noteContact(id, options = {}) {
    const key = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
    if (!key) return null;
    const at = Number.isFinite(options.now) ? options.now : now();
    try {
      beliefs = observePerson(beliefs || createBeliefStore({ now: at }), key, { contact: true, valence: 0, source: options.key || 'message' }, { now: at });
      noteBondContact(key, at);
      contactDirty = true;
      if (!contactTimer) {
        contactTimer = setTimeout(() => { flushBeliefs().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/mind/groundwork.mjs:86')); }, 5000);
        if (typeof contactTimer.unref === 'function') contactTimer.unref();
      }
      return beliefs.people[key] || null;
    } catch { return null; }
  }

  /** 群活跃：只更新 lastActiveAt/证据，不改接纳度与气氛（那是互动评价的事）。 */
  function noteGroupActivity(groupKey, options = {}) {
    const key = typeof groupKey === 'string' ? groupKey.trim() : '';
    if (!key) return null;
    const at = Number.isFinite(options.now) ? options.now : now();
    try {
      beliefs = observeGroup(beliefs || createBeliefStore({ now: at }), key, { active: true, source: options.source || 'message' }, { now: at });
      contactDirty = true;
      if (!contactTimer) {
        contactTimer = setTimeout(() => { flushBeliefs().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/mind/groundwork.mjs:102')); }, 5000);
        if (typeof contactTimer.unref === 'function') contactTimer.unref();
      }
      return beliefs.groups[key] || null;
    } catch { return null; }
  }

  async function start() {
    const at = now();
    startedAt = at;
    try {
      lifeLog.append({ type: 'process.started', payload: { pid: process.pid, at } }, { at });
    } catch { /* 生命线写失败不阻塞启动 */ }

    const rawSelf = store.exists('self-state.json') ? store.readJson('self-state.json', null) : null;
    const baseSelf = normalizeSelfState(rawSelf || createSelfState({ at }));
    // [OFFLINE-REST] 进程不在的时段不是“醒着耗精力”：超过 2h 的断档按离线休息处理，
    // 否则开机第一次 tick 会用 13h 的 dt 把精力从 0.6 直接抽到 0.02（实测 2026-11-04 11:04）。
    const offlineGap = at - baseSelf.at > 2 * 3600 * 1000;
    selfState = tickSelfState(baseSelf, { now: at, sleeping: offlineGap, activity: 'idle' });
    try { await store.writeJson('self-state.json', selfState); } catch { /* 只影响持久化 */ }

    const rawBeliefs = store.exists('beliefs.json') ? store.readJson('beliefs.json', null) : null;
    beliefs = rawBeliefs ? normalizeBeliefStore(rawBeliefs) : createBeliefStore({ now: at });
    // [BELIEF-SEED] 第一次上线：用存量 people.json 播种“认识的人”，否则信念库要数周才有数据。
    // 只在中性字段上播种（trust/affinity 仍 0.5），熟悉度来自真实互动计数。
    if (Object.keys(beliefs.people).length === 0 && typeof opts.peopleFile === 'string') {
      try {
        const people = readPeopleFile(opts.peopleFile);
        beliefs = seedBeliefsFromPeople(people, { now: at });
      } catch { /* 文件缺失/损坏不阻塞启动 */ }
    }
    try { await store.writeJson('beliefs.json', beliefs); } catch { /* 只影响持久化 */ }

    // [OFFLINE-NARRATIVE] 离线叙事：读启动前的最近 24h 事件（不含本次启动），确定性摘要。
    let narrative = '';
    try {
      const prior = lifeLog.read({ from: at - 24 * 3600 * 1000, to: at - 1, limit: 500 });
      const summary = summarizeOffline(prior, { now: at });
      narrative = summary.text;
      narrativeText = narrative;
      await store.writeJson('offline-narrative.json', summary);
    } catch { /* 叙事失败不阻塞启动 */ }

    return {
      at,
      selfState: summarizeSelfState(selfState),
      people: Object.keys(beliefs.people).length,
      groups: Object.keys(beliefs.groups).length,
      lifeLog: lifeLog.stats(),
      narrative,
    };
  }

  function snapshot() {
    return {
      v: GROUNDWORK_VERSION,
      at: startedAt || now(),
      selfState,
      beliefs,
    };
  }

  /** 创建（但不启动）生命内核。宿主显式调用 kernel.tick() 才会推进，零自动行为。 */
  function newKernel(extra = {}) {
    return createKernel({
      ...extra,
      ports: extra.ports || createHostPorts({ lifeLog, store, clock: { now }, at: now() }),
    });
  }

  return {
    v: GROUNDWORK_VERSION,
    store,
    lifeLog,
    createKernel: newKernel,
    start,
    snapshot,
    noteContact,
    noteGroupActivity,
    flushBeliefs,
    get selfState() { return selfState; },
    get beliefs() { return beliefs; },
    get narrative() { return narrativeText; },
  };
}

export { restoreBeliefStore };
