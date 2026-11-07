// outgoing-queue.mjs · 出站发送的串行队列 + 每会话失败记账（纯状态机，无 IO）
//
// 为什么要有它（2026-10-28 架构审视 S2-1）：
//   `bridge.js` 有 4 条发送路径共用同一组进程级可变状态：
//     · sendChain：一个 promise 链，保证「先文字后表情/语音」的真人顺序；
//     · lastSendFailed：每个会话上一次发送是否失败，供 lastSendSucceeded 判断
//       "我到底说没说上话"（错了会让桥接以为已开口，从而静默抑制后续回复）。
//   它们写在 main() 的闭包里，任何一处漏改都不会被单测发现。抽出来之后：
//     · 顺序保证 = 队列语义，可单测；
//     · 失败记账 = 有界 Map，可断言；
//     · 调用方只剩 enqueue / markFailed / succeeded 三个动词。
//   stats() 是只读诊断：{ pending, failed }，给 /api/status.onebot 和 health-check 用。
//
// 纪律：
//   · 队列不因单个任务失败而卡死（失败任务自己负责记日志，队列继续跑）；
//   · 任务抛错不会变成 unhandledRejection —— 返回的 promise 已挂 catch 兜底，
//     enqueue 的返回值可以安全地不被 await；
//   · whenIdle() 返回「调用时刻的队尾」，与旧代码 `sendChain.then(...)` 的语义一致
//     （之后新入队的任务不会把它拖住）。

/**
 * 创建一个出站队列。
 * @param {{onError?: (error: unknown) => void}} [options]
 */
export function createOutgoingQueue(options = {}) {
  const { onError } = options;
  let tail = Promise.resolve();
  let pending = 0;
  /** key -> true；下一次成功发送时清除 */
  const failed = new Map();

  /**
   * 排入一个发送任务。任务按入队顺序串行执行。
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>} 该任务自己的结果（失败时 reject，但已标记为已处理）
   */
  function enqueue(task) {
    pending += 1;
    const run = tail.then(() => task());
    // 队尾吞掉异常：一个任务失败不能阻断后面的发送。
    const settled = run.finally(() => { pending = Math.max(0, pending - 1); });
    tail = settled.catch((error) => {
      try { onError?.(error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'outgoing-queue.mjs:44'); }
    });
    // 返回值也挂一个 catch，避免调用方不 await 时产生 unhandledRejection；
    // 调用方仍可 await 拿到真实结果/异常（同一 promise）。
    run.catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/send/outgoing-queue.mjs:48'));
    return run;
  }

  return {
    enqueue,
    /** 调用时刻队尾的 promise（等待此刻已排队的任务全部结束）。 */
    whenIdle() { return tail; },
    /** 标记某会话本轮发送失败（下一次成功即清除）。 */
    markFailed(key) { failed.set(String(key), true); },
    /** 清除失败标记（开始新一批发送前调用，与旧代码 `delete` 等价）。 */
    clearFailed(key) { failed.delete(String(key)); },
    /** 上一次发送是否成功（没有失败记录 = 成功）。 */
    succeeded(key) { return failed.get(String(key)) !== true; },
    /** 仅用于诊断/测试。 */
    failedCount() { return failed.size; },
    /** 只读诊断：队列里还没结束的任务数 + 失败会话数。 */
    stats() { return { pending, failed: failed.size }; },
  };
}
