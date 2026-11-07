// conversation-actor.mjs · 每个 QQ 会话一个"串行信箱"（P3 的基础件）
//
// 为什么要它（见 docs/internal/_archive/架构/架构-目标架构-20261103.md §4.2）：
//   现在 state.sessions / socialV2.conversations 是全局 Map，定时器、事件、回复
//   同时改同一个 key 的状态；串行化靠 turn 调度的"忙等"和一堆 if，谁都能插进来。
//   目标是把"同一个 key 的处理"收进一个 actor：外部只投递任务，actor 内部串行执行；
//   不同 key 之间互不阻塞。
//
// 设计取舍：
//   · 不是线程/进程，只是一个 Promise 串行队列（单机单进程，够用且可测）；
//   · 单个任务失败不阻塞后续任务（错误交给 onError，队列继续）；
//   · dispose 之后拒绝新任务，正在跑的任务不受影响；
//   · 纯逻辑，不 import 项目内任何模块——接线由调用方做。

/**
 * 创建一个会话 actor。
 * @param {{key:string, onError?:(error:Error, meta?:any)=>void}} options
 */
export function createConversationActor({ key, onError } = {}) {
  if (!key) throw new Error('createConversationActor: key 必填');
  let queue = [];
  let running = false;
  let disposed = false;
  let inflight = 0;
  let busySince = 0;

  const report = (error, meta) => {
    try { onError?.(error, meta); } catch { /* best-effort：报错回调自己炸了也不影响队列 */ }
  };

  function pump() {
    if (running || disposed) return;
    const item = queue.shift();
    if (!item) return;
    running = true;
    inflight += 1;
    busySince = Date.now();
    const settle = () => { inflight -= 1; running = false; };
    Promise.resolve()
      .then(() => item.task())
      .then(
        // 先结算再 resolve：调用方 await 到结果时 idle() 已经是准确的
        (value) => { settle(); item.resolve(value); pump(); },
        (error) => { settle(); report(error, item.meta); item.reject(error); pump(); },
      );
  }

  return {
    key,
    /** 投递一个任务，返回它的结果 Promise（串行执行） */
    post(task, meta) {
      if (disposed) return Promise.reject(new Error(`actor ${key} 已销毁`));
      if (typeof task !== 'function') return Promise.reject(new TypeError('actor.post 需要函数'));
      return new Promise((resolve, reject) => {
        queue.push({ task, meta, resolve, reject });
        pump();
      });
    },
    /** 当前排队中（不含正在跑的）任务数 */
    pending() { return queue.length; },
    /** 正在跑的任务数（0/1） */
    inFlight() { return inflight; },
    /** 当前任务开始时间（没有在跑则 0）；给调用方做卡住就绕过的兜底判断 */
    busySince() { return busySince; },
    /** 空闲：队列空且没有在跑的任务 */
    idle() { return !running && queue.length === 0; },
    /** 丢弃排队中的任务并拒绝新任务；正在跑的跑完为止 */
    dispose() {
      disposed = true;
      const rest = queue;
      queue = [];
      for (const item of rest) item.reject(new Error(`actor ${key} 已销毁`));
    },
  };
}

/**
 * 一个进程内的 actor 注册表：同一个 key 永远拿到同一个 actor。
 */
export function createActorRegistry({ onError } = {}) {
  const actors = new Map();
  return {
    get(key) {
      if (!key) throw new Error('actorRegistry.get: key 必填');
      let actor = actors.get(key);
      if (!actor) {
        actor = createConversationActor({ key, onError });
        actors.set(key, actor);
      }
      return actor;
    },
    size() { return actors.size; },
    keys() { return [...actors.keys()]; },
    disposeAll() {
      for (const actor of actors.values()) actor.dispose();
      actors.clear();
    },
  };
}
