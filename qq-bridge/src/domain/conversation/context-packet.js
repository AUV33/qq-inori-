// context-packet.js · 上下文与权限的边界（类型化，而不是靠约定）
//
// 2026-10-28 事故：ownlife 会话拿到了主人私聊的 agentToken + 消息快照，顺手发了两句私信。
// 根因不是某个函数写错，而是"上下文内容"和"它能用的权限"混在同一个字符串里，
// 谁把字符串拼进去，谁就顺带给了权限。
//
// 这个模块只做一件事：把"给什么内容"和"能拿什么权限"分开声明。
//   - chat/task：需要令牌才能发消息 → 允许；
//   - isolated：纯背景（自由时间/反思/日记/学习）→ 令牌必须为空，内容里也不许出现已知令牌；
//   - gate：只读判定 → 不给令牌。
// 一旦违反，构造时报错/剥离，而不是等到她发出消息才发现。

export const CONTEXT_PURPOSES = {
  chat: { tokens: true, snapshot: true, maySend: true },
  task: { tokens: true, snapshot: true, maySend: true },
  gate: { tokens: false, snapshot: false, maySend: false },
  isolated: { tokens: false, snapshot: false, maySend: false },
};

export function purposeCaps(purpose) {
  return CONTEXT_PURPOSES[purpose] ?? CONTEXT_PURPOSES.isolated;
}

/**
 * 构造一个上下文包。isolated/gate 传了令牌就直接抛错——这是编程错误，不该静默放过。
 */
export function buildContextPacket({ purpose = 'isolated', content = '', tokens = {}, meta = {} } = {}) {
  const caps = purposeCaps(purpose);
  const keys = Object.keys(tokens || {}).filter((k) => tokens[k]);
  if (!caps.tokens && keys.length) {
    throw new Error(`context packet 违规：purpose=${purpose} 不允许携带令牌（收到 ${keys.join(',')}）`);
  }
  return {
    purpose,
    caps,
    content: String(content ?? ''),
    tokens: caps.tokens ? { ...tokens } : {},
    meta: { ...(meta || {}) },
  };
}

/** 取提示词正文（权限单独在 packet.tokens 里，由投递逻辑决定怎么用） */
export function promptTextOf(packet) {
  return String(packet?.content ?? '');
}

/**
 * 兜底护栏：内容里如果混进了已知会话令牌，把它剥掉并报告（不抛错，避免把整轮唤醒弄挂）。
 * @returns {{text: string, hits: number}}
 */
export function stripKnownTokens(text, knownTokens = []) {
  let out = String(text ?? '');
  let hits = 0;
  for (const token of knownTokens) {
    const value = String(token ?? '');
    if (value.length < 16) continue; // token 都是 24 字节 hex，太短的不算
    if (!out.includes(value)) continue;
    out = out.split(value).join('[会话令牌已隐藏]');
    hits += 1;
  }
  return { text: out, hits };
}

/** 从会话状态里收集所有已知令牌（只用于护栏比对，不用于投递） */
export function collectSessionTokens(conversations) {
  const out = [];
  const fields = ['agentToken', 'ownerAgentToken', 'readToken'];
  for (const st of conversations?.values?.() ?? []) {
    for (const f of fields) if (st?.[f]) out.push(String(st[f]));
  }
  return [...new Set(out)];
}
