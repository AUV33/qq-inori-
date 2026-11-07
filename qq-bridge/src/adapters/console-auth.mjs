// [SPLIT 阶段1] 控制台鉴权函数组，从 console-server.mjs (61–135) 抽出。
//
// 为什么这样抽：原来这 8 个函数定义在 startConsoleServerCore 的闭包里，只通过 __deps
// 访问外部状态，没有任何其它自由变量。抽成 createConsoleAuth(deps) 工厂后：
//   · 依赖面变成显式的 deps 参数，可独立构造、独立单测（尤其是安全敏感的定长比较）；
//   · console-server.mjs 里用解构赋值接回同名局部变量，后续 180 个路由的引用一字不改；
//   · 行为零变化：tokenEq 仍用 crypto.timingSafeEqual，空令牌仍失败关闭。
export function createConsoleAuth(deps) {
  // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
  // 可用响应时延逐字节试探。与控制台令牌（crypto.timingSafeEqual）保持一致。
  const tokenEq = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && deps.crypto.timingSafeEqual(x, y);
  };

  const agentTokenOk = (key, token) => {
    const canonical = deps.canonicalV2Key(key);
    const st = deps.socialV2.conversations.get(canonical ?? key);
    if (!st) return false;
    if (st.agentToken && tokenEq(token, st.agentToken)) return true;
    return !!(st.ownerAgentToken && tokenEq(token, st.ownerAgentToken));
  };

  /**
   * 令牌是否匹配**任意**一个活跃二代会话。
   *
   * 用途是集中式纵深防御（x-agent-call 关卡）：各端点自己那套
   * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
   * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
   * 端点漏写时会整个失效。
   */
  const isLiveAgentToken = (token) => {
    if (typeof token !== 'string' || !token) return false;
    for (const st of deps.socialV2.conversations.values()) {
      if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      if (st?.ownerAgentToken && tokenEq(token, st.ownerAgentToken)) return true;
    }
    return false;
  };

  // [GROUP-WINDOW] 只读 token 也认作「智能体调用」，但只对 unread/recent 有效。
  const isReadToken = (token) => {
    if (typeof token !== 'string' || !token) return false;
    for (const st of deps.socialV2.conversations.values()) {
      if (st?.readToken && tokenEq(token, st.readToken)) return true;
    }
    return false;
  };

  // [SELF-STATE] 她自己的状态类端点（日程 / 好奇心 / 愿望 / 自唤醒 / 黑话判定 / 作息节奏）：
  // 只碰她自己的状态，或只是"把自己叫回去"。自主时间的隔离会话只握有只读 token、
  // 而且没有会话 key，所以这些端点接受只读 token。发消息 / 标已读 / 读别人消息不受影响。
  const selfStateTokenOk = (req) => {
    const t = req.headers['x-agent-token'];
    return !!t && (isLiveAgentToken(t) || isReadToken(t));
  };

  // [CROSS-SEND] 令牌属于哪个会话（调用方）。qq_send_to / qq_send_private_message
  // 是「跨会话发送」，token 认的是调用方，不是目标会话——以前按目标校验，
  // 导致她在群里永远发不出私聊（实测被拒：agent token 无效）。
  const callerKeyForToken = (token) => {
    if (typeof token !== 'string' || !token) return null;
    for (const [key, st] of deps.socialV2.conversations) {
      if (st?.agentToken && tokenEq(token, st.agentToken)) return key;
      if (st?.ownerAgentToken && tokenEq(token, st.ownerAgentToken)) return key;
    }
    return null;
  };

  // [PERM-BY-PERSON] 只有 owner lane（或主人私聊）的令牌算「主人发起」
  const callerTokenIsOwner = (token) => {
    if (typeof token !== 'string' || !token) return false;
    const ownerKey = `private:${String(deps.cfg.ownerQQ ?? '')}`;
    for (const [key, st] of deps.socialV2.conversations) {
      if (st?.ownerAgentToken && tokenEq(token, st.ownerAgentToken)) return true;
      if (key === ownerKey && st?.agentToken && tokenEq(token, st.agentToken)) return true;
    }
    return false;
  };

  // [GROUP-ADMIN-OWNER] 群管理动作只认 owner 私聊令牌；普通群会话 token（哪怕
  // 它是当前群的合法 agentToken）不能禁言/踢人/撤回。群内容不可信，这是硬边界。
  const ownerPrivateTokenOk = (token) => {
    if (typeof token !== 'string' || !token) return false;
    const ownerKey = `private:${String(deps.cfg.ownerQQ ?? '')}`;
    const st = deps.socialV2.conversations.get(ownerKey);
    if (!st) return false;
    return !!((st.agentToken && tokenEq(token, st.agentToken))
      || (st.ownerAgentToken && tokenEq(token, st.ownerAgentToken)));
  };

  return {
    tokenEq,
    agentTokenOk,
    isLiveAgentToken,
    isReadToken,
    selfStateTokenOk,
    callerKeyForToken,
    callerTokenIsOwner,
    ownerPrivateTokenOk,
  };
}
