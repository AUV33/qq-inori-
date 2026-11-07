// Agent token 账本：按会话保留当前代 + 上一代，供日志/出站脱敏使用。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。状态与函数同住一个模块，
// 避免集合只增不减，也避免硬性 LRU 淘汰掉仍然有效的活令牌。
export const CONVERSATION_TOKENS = new Map();
export const KNOWN_AGENT_TOKENS = new Set();
const MAX_KNOWN_AGENT_TOKENS = 512;

/** 按当前代 token 反查会话 key（跨场景动作用来确认“是谁在说话”）。 */
export function keyForAgentToken(token) {
  const tk = String(token ?? '');
  if (!tk) return null;
  for (const [key, pair] of CONVERSATION_TOKENS) if (pair && pair[0] === tk) return key;
  return null;
}

/** 记录某会话的当前 agentToken：丢掉两代之前的旧 token。 */
export function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除时，连同它的 token 一起从脱敏集合摘掉。 */
export function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}
