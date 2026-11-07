// send-guard.mjs · 出站发送的「权限快照」与静默模式闸门（从 bridge.js 的 main() 抽出，S2-4）
//
// 为什么单独成模块：
//   发送前的最后一道门是**安全相关**的——一条消息已经排队、甚至已经过了 LLM，如果这期间
//   会话被移出白名单、模式被切走、或 DSH 会话被轮换，这句话就不该再发出去。
//   原实现是 main() 里的闭包，判定依赖三个进程状态；抽出来后，"什么时候必须取消发送"
//   变成可离线断言的契约（有单测锁），而不是"看代码的人相信它对"。
//
// 纪律：
//   · `createSendGuard` 只**捕获**当时的策略与会话 id，不读任何全局；判定通过注入的
//     isAllowed / policyNow / sessionNow 完成，测试可以精确模拟每一种失效。
//   · 失效一律**抛错**（调用方会捕获并记日志）；静默放行比误发更危险。
//   · `shouldBlockSilentReply` 只回答"静默模式下这条该不该发"：除主人私聊外一律不发。

/**
 * 生成一次发送的守卫函数。
 * @param {object} args
 * @param {string} args.key
 * @param {unknown} args.policy        捕获时的会话策略（模式变化即失效）
 * @param {unknown} args.sessionId     捕获时的 DSH 会话 id（轮换即失效；空值表示还没建会话）
 * @param {(key: string) => boolean} args.isAllowed    当前是否仍允许该会话
 * @param {(key: string) => unknown} args.policyNow     当前策略
 * @param {(key: string) => unknown} args.sessionNow    当前会话 id
 * @returns {() => void} 通过时静默返回，失效时抛错
 */
export function createSendGuard({ key, policy, sessionId, isAllowed, policyNow, sessionNow }) {
  return () => {
    if (!isAllowed(key) || policyNow(key) !== policy
        || (sessionId && sessionNow(key) !== sessionId)) {
      throw new Error('发送已取消：会话、模式或白名单已变化');
    }
  };
}

/**
 * 静默模式下是否应拦下这条出站消息（主人私聊除外）。
 * @param {string} key
 * @param {{ mode?: string, ownerQQ?: unknown }} args
 */
export function shouldBlockSilentReply(key, { mode, ownerQQ } = {}) {
  return mode === 'silent' && key !== `private:${String(ownerQQ ?? '')}`;
}
