// kernel/ports.mjs · 端口：内核与世界的唯一接缝。
//
// 干什么：定义内核需要的 6 个能力（时钟/事件流/状态持久化/行动/感知/记忆），
//         并提供一个纯内存实现，让整颗心脏在没有任何外部服务时也能离线跑起来。
// 为什么：旧系统 253 个 import + 20 多个定时器直接绑死 DSH/QQ/模型/python，
//         于是"她活着"这件事无法在没有整机环境时被证明。端口让内核可独立验证。
// 输入输出：createMemoryPorts 返回可注入对象；assertPorts 校验必需方法。
// 失败模式：缺端口抛错（装配期暴露，不在 tick 中静默降级）。
// 不做什么：不连接真实服务；真实适配由 adapters 层实现后注入，内核不改一行。

export const PORT_NAMES = Object.freeze(['clock', 'events', 'state', 'act', 'sense', 'memory']);

const REQUIRED_METHODS = Object.freeze({
  clock: ['now'],
  events: ['append', 'read', 'since'],
  state: ['load', 'save'],
  act: ['perform'],
  sense: ['poll'],
  memory: ['consolidate', 'forget'],
});

export function assertPorts(ports) {
  const missing = [];
  for (const name of PORT_NAMES) {
    const p = ports?.[name];
    if (!p || typeof p !== 'object') { missing.push(name); continue; }
    for (const method of REQUIRED_METHODS[name]) {
      if (typeof p[method] !== 'function') missing.push(`${name}.${method}`);
    }
  }
  if (missing.length) throw new Error(`kernel ports missing: ${missing.join(', ')}`);
  return ports;
}

/**
 * 纯内存实现：用于测试、离线回放、本地推演。
 * 形状与真实适配器一致，替换注入即可上线，内核无需改动。
 */
export function createMemoryPorts(opts = {}) {
  let t = Number.isFinite(opts.at) ? opts.at : Date.now();
  const log = [];
  let snapshot = null;
  const inbox = Array.isArray(opts.inbox) ? [...opts.inbox] : [];
  const actions = [];
  const consolidated = [];
  const forgotten = [];

  const clock = {
    now: () => t,
    set: (ms) => { if (Number.isFinite(ms)) t = ms; return t; },
    advance: (ms) => { t += Number(ms) || 0; return t; },
  };
  const events = {
    append: (row) => { log.push(row); return row; },
    read: () => log.slice(),
    since: (from) => log.filter((e) => Number(e.at) >= Number(from)),
    get size() { return log.length; },
  };
  const state = {
    load: () => snapshot,
    save: (s) => { snapshot = s; return s; },
  };
  const sense = {
    poll: () => inbox.splice(0),
    push: (input) => { inbox.push(input); return inbox.length; },
  };
  // 会发消息的意图要回报 sentKey，内核据此写 message.sent 并清掉 unread。
  // 真实适配器同样返回 { ok, sentKey }；静默意图（rest/reflect）不返回。
  // 只有"对人说话"的意图会发消息；learn/explore 是学习/探索动作，不该在测试端口里
  // 偷偷发一条 QQ 消息（否则社交饥饿会被探索动作反复喂饱，闭环在离线推演里失真）。
  const SENDING = new Set(['reply', 'initiate', 'continue', 'repair']);
  const act = {
    perform: (intention) => {
      actions.push(intention);
      const willSend = SENDING.has(intention?.selected);
      return { ok: true, at: t, ...(willSend ? { sentKey: intention?.targetKey || 'private:1' } : {}) };
    },
    history: () => actions.slice(),
  };
  const memory = {
    consolidate: (rows) => { for (const r of rows) consolidated.push(r); return rows.length; },
    forget: (rows) => { for (const r of rows) forgotten.push(r); return rows.length; },
    get consolidated() { return consolidated.slice(); },
    get forgotten() { return forgotten.slice(); },
  };

  return assertPorts({ clock, events, state, act, sense, memory });
}

/**
 * 宿主适配器：把**现有**的生命线/状态仓包装成端口，内核不必再造一套并行数据。
 * 只依赖传入对象的形状，不 import 任何 domain（内核保持零反向依赖）。
 * 未提供的能力退化为内存实现，便于分步接线。
 */
export function createHostPorts(host = {}) {
  const mem = createMemoryPorts({ at: host.at });
  const lifeLog = host.lifeLog;
  const store = host.store;

  const events = lifeLog && typeof lifeLog.append === 'function' && typeof lifeLog.read === 'function'
    ? {
        append: (row) => {
          // life-log 只保留 {v,id,at,type,key,actor,payload,trace}；把 phase 带进 payload 以便回放。
          lifeLog.append({ type: row.type, key: String(row.payload?.key || ''), payload: { ...row.payload, phase: row.phase } }, { at: row.at });
          return row;
        },
        read: () => lifeLog.read({ limit: 100000 }),
        since: (from) => lifeLog.read({ from: Number(from), limit: 100000 }),
      }
    : mem.events;

  const state = store && typeof store.readJson === 'function' && typeof store.writeJson === 'function'
    ? {
        load: () => { try { return store.readJson(host.stateFile || 'kernel-state.json', null); } catch { return null; } },
        save: (s) => { try { store.writeJson(host.stateFile || 'kernel-state.json', s); } catch { /* best-effort */ } return s; },
      }
    : mem.state;

  return assertPorts({
    clock: host.clock || mem.clock,
    events,
    state,
    act: host.act || mem.act,
    sense: host.sense || mem.sense,
    memory: host.memory || mem.memory,
  });
}

/**
 * 真实 QQ 适配器骨架（绞杀者 P2）：把**现有**旧系统的感知/行动/记忆能力挂到内核 6 端口。
 * 设计：六边形——由调用方（app.mjs）把旧系统的真实函数注入 deps，内核零反向依赖。
 * 未提供的能力退化为内存实现（createHostPorts 已处理 events/state 的 lifeLog/store 接线，
 * 且 state 写独立 kernel-state.json，绝不碰旧系统的 self-state/beliefs/lessons/affect）。
 *
 * 接线清单（TODO，按 P2 顺序填充，改这里、内核一行不用动）：
 *   sense.poll         → 旧 message-intake 的未读/入站拉取，返回 [{type, payload, at}]
 *   act.perform        → 旧 send-service 的真实发送；会发消息的意图回报 { ok, sentKey }
 *   memory.consolidate → 旧 memory/* 巩固（输入为事件窗口）
 *   memory.forget      → 旧 memory/* 遗忘（输入为 staleLessons）
 * 注意：本骨架不回写任何旧状态；开启 P2 前仍保持"零行为变更"。
 */
export function createQQPorts(deps = {}) {
  const host = {
    at: deps.at,
    clock: deps.clock,
    lifeLog: deps.lifeLog,
    store: deps.store,
    act: deps.act,       // TODO(P2): 包装旧 send-service / mcp 发送
    sense: deps.sense,   // TODO(P2): 包装旧 message-intake / 未读拉取
    memory: deps.memory, // TODO(P2): 包装旧 memory/* 巩固与遗忘
  };
  return createHostPorts(host);
}

/**
 * 影子端口：只推演、不产生真实副作用。
 * 关键修复（审计）：以前 app 用 createQQPorts，act 退化成内存桩，会给 initiate/reply 返回 sentKey，
 * 内核于是写下根本不存在的 message.sent —— 影子账本"她说过话"是假的。
 * 影子端口明确不返回 sentKey；场景不发送、记忆不谎报条数。
 * @param {{at?:number, store?:object, lifeLog?:object, stateFile?:string,
 *          clock?:object, sense?:object, act?:object, memory?:object, inbox?:Array}} deps
 */
export function createShadowPorts(deps = {}) {
  const at = Number.isFinite(deps.at) ? deps.at : Date.now();
  const actions = [];
  const inbox = Array.isArray(deps.inbox) ? [...deps.inbox] : [];

  const shadowAct = {
    perform: (decision, state, tickAt) => {
      actions.push({ selected: decision?.selected, at: tickAt ?? at });
      // 不返回 sentKey：内核据此不写 message.sent（影子没有真的发出任何消息）。
      return { ok: true, shadow: true, at: tickAt ?? at };
    },
    history: () => actions.slice(),
  };
  const shadowSense = {
    poll: () => inbox.splice(0),
    push: (input) => { inbox.push(input); return inbox.length; },
  };
  const shadowMemory = {
    // 影子不接真实巩固/遗忘：返回 0 让内核不写 memory.consolidated 的假条数。
    consolidate: () => 0,
    forget: () => 0,
  };

  const ports = createHostPorts({
    at,
    clock: deps.clock,
    lifeLog: deps.lifeLog, // 影子默认不传 lifeLog，避免污染唯一事件流
    store: deps.store,
    stateFile: deps.stateFile || 'kernel-state.json',
    act: deps.act || shadowAct,
    sense: deps.sense || shadowSense,
    memory: deps.memory || shadowMemory,
  });
  if (!ports.act.history) ports.act.history = shadowAct.history;
  if (!ports.sense.push) ports.sense.push = shadowSense.push;
  return ports;
}
