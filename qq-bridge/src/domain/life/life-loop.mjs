// life-loop.mjs · 生命循环：让“时间”真正流过她的状态
//
// 干什么：按固定节拍推进 SelfState（精力/社交饥饿/好奇/情绪衰减），原子持久化，
//         每小时写一条 life.tick 检查点；提供 sleepStart/sleepEnd 事件与 start/stop。
// 为什么：没有心跳的自我状态只是“启动时算一次”，不是活着；A2 稳态需要真实时间驱动。
// 输入输出：依赖注入 store（读写 self-state.json）与 lifeLog（只追加）；now 可注入。
// 失败模式：单次 tick 失败不杀进程；持久化失败只记日志；定时器 unref，不挡退出。
// 不做什么：不决定睡/醒（读取外部 lifeState）、不生成对话、不发消息、不调模型。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.1 / §4.2 与 R2

import { createSelfState, normalizeSelfState, tickSelfState, applyEvent, summarizeSelfState, needsPressure } from '../mind/self-state.mjs';

export const LIFE_LOOP_VERSION = 1;
export const DEFAULT_INTERVAL_MS = 60 * 1000;
export const DEFAULT_CHECKPOINT_MS = 60 * 60 * 1000;
export const DEFAULT_MIN_TICK_MS = 30 * 1000;

/**
 * @param {{store:object, lifeLog:object, now?:()=>number, selfStatePath?:string,
 *          intervalMs?:number, checkpointMs?:number, minTickMs?:number,
 *          sleeping?:()=>boolean, log?:Function,
 *          onTick?:({at:number, state:object})=>void}} opts
 */
export function createLifeLoop(opts = {}) {
  if (!opts.store || typeof opts.store.readJson !== 'function') throw new Error('life-loop: store required');
  const store = opts.store;
  // [STATE-HUB] 有 hub 时，self-state 的读写全权交给单一写入者（state-hub.json）。
  const hub = opts.hub && typeof opts.hub.tick === 'function' ? opts.hub : null;
  const lifeLog = opts.lifeLog && typeof opts.lifeLog.append === 'function' ? opts.lifeLog : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const statePath = typeof opts.selfStatePath === 'string' ? opts.selfStatePath : 'self-state.json';
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const checkpointMs = Number.isFinite(opts.checkpointMs) && opts.checkpointMs > 0 ? opts.checkpointMs : DEFAULT_CHECKPOINT_MS;
  const minTickMs = Number.isFinite(opts.minTickMs) && opts.minTickMs >= 0 ? opts.minTickMs : DEFAULT_MIN_TICK_MS;
  const sleeping = typeof opts.sleeping === 'function' ? opts.sleeping : () => false;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let state = null;
  let timer = null;
  let lastCheckpointAt = 0;
  let ticks = 0;
  let lastError = '';
  // [SLEEP-EVENT] sleeping 是外部谓词（life.get().state），不写进 self-state，
  // 所以翻转状态必须由本模块自己持有；用 state.sleeping 判断会恒为 false → 每拍重复写事件。
  let lastSleeping = null;

  function load() {
    if (hub) { state = normalizeSelfState(hub.state?.self || null); return state; }
    const raw = store.exists ? (store.exists(statePath) ? store.readJson(statePath, null) : null) : store.readJson(statePath, null);
    state = normalizeSelfState(raw || createSelfState({ at: now() }));
    return state;
  }

  function ensure() {
    if (!state) load();
    return state;
  }

  async function persist() {
    try {
      if (hub) await hub.flush();
      else await store.writeJson(statePath, state);
      return true;
    } catch (error) {
      lastError = String(error?.message ?? error);
      log('[life] 自我状态持久化失败（忽略）: ' + lastError);
      return false;
    }
  }

  async function tick(options = {}) {
    const s = ensure();
    const at = Number.isFinite(options.now) ? options.now : now();
    const dt = Math.max(0, at - s.at);
    if (!options.force && dt < minTickMs) return { skipped: true, state: s, dt };
    // [OFFLINE-REST] 定时器停摆/系统休眠造成的长断档按离线休息处理，不当作清醒耗能。
    const offlineGap = dt > 2 * 3600 * 1000;
    const isSleeping = offlineGap || sleeping();
    const wasSleeping = lastSleeping;
    const next = hub
      ? hub.tick({ sleeping: isSleeping, activity: isSleeping ? 'idle' : (options.activity || 'idle'), at })
      : tickSelfState(s, { now: at, sleeping: isSleeping, activity: isSleeping ? 'idle' : (options.activity || 'idle') });
    state = next;
    ticks += 1;
    await persist();
    // [SLEEP-EVENT] 旧实现只有 sleepStart()/sleepEnd() 两个方法，生产代码从未调用 →
    // 生命线里 sleeps 恒为 0，稳态维度建立在空数据上。改为在心跳里检测状态翻转，
    // 天然去重（只在边界写一次），无需外部接线，也不依赖 lifeState 的切换时机。
    if (wasSleeping !== null && isSleeping !== wasSleeping) {
      try {
        lifeLog?.append({ type: isSleeping ? 'sleep.started' : 'sleep.ended', payload: { energy: next.energy, offlineGap } }, { at });
      } catch (error) { lastError = String(error?.message ?? error); }
    }
    lastSleeping = isSleeping;
    // [KERNEL-SHADOW] 同一拍把状态交给生命内核做影子对账，不新增定时器。
    // 钩子必须 best-effort：内核是影子，绝不能因为它失败而影响既有生命循环。
    if (typeof opts.onTick === 'function') {
      try { opts.onTick({ at, state: next, sleeping: isSleeping }); } catch (error) {
        lastError = String(error?.message ?? error);
        log('[life] 内核影子钩子失败（忽略）: ' + lastError);
      }
    }
    if (!lastCheckpointAt || at - lastCheckpointAt >= checkpointMs) {
      lastCheckpointAt = at;
      try {
        lifeLog?.append({ type: 'life.tick', payload: { energy: next.energy, socialHunger: next.socialHunger, curiosity: next.curiosity, stress: next.stress, mood: next.mood, sleeping: isSleeping } }, { at });
      } catch (error) { lastError = String(error?.message ?? error); }
    }
    return { skipped: false, state: next, dt };
  }

  function start() {
    if (timer) return timer;
    ensure();
    timer = setInterval(() => { tick().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/life/life-loop.mjs:116')); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function sleepStart(at = now()) {
    state = hub ? hub.apply({ type: 'sleep_start', source: 'life-loop' }) : applyEvent(ensure(), { type: 'sleep_start', source: 'life-loop' }, { now: at });
    await persist();
    try { lifeLog?.append({ type: 'sleep.started', payload: { energy: state.energy } }, { at }); } catch { /* best-effort */ }
    return state;
  }

  async function sleepEnd(at = now()) {
    state = hub ? hub.apply({ type: 'sleep_end', source: 'life-loop' }) : applyEvent(ensure(), { type: 'sleep_end', source: 'life-loop' }, { now: at });
    await persist();
    try { lifeLog?.append({ type: 'sleep.ended', payload: { energy: state.energy } }, { at }); } catch { /* best-effort */ }
    return state;
  }

  function status() {
    const s = state || ensure();
    return {
      v: LIFE_LOOP_VERSION,
      at: s.at,
      running: Boolean(timer),
      ticks,
      lastCheckpointAt,
      lastError,
      summary: summarizeSelfState(s),
      pressure: needsPressure(s),
      state: s,
    };
  }

  return { v: LIFE_LOOP_VERSION, load, tick, start, stop, sleepStart, sleepEnd, status, get state() { return ensure(); } };
}
