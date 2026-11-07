// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具**不在 MCP 层做目标白名单校验**：目标群/私聊是否命中 config.json 的
//   allow.groups / allow.private 由桥接侧（bridge.js 的 auditAndSend 及各发送端点）统一负责——
//   所有 QQ 发送都经由桥接 HTTP API，MCP 只负责把目标转发出去（见下方「这三个仍然只在调用时由桥接校验」）。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './domain/shared/sensitive.js';
import { serializeModelData } from './domain/persona/qq-model-view.js';
// [TOOL-CATALOG] 分类→工具→调用 三层
import { renderCatalog, renderCategory } from './domain/persona/tool-catalog.js';
import { TOOL_CONFIG_FLAGS } from './domain/shared/tool-flags.js';
// [ME] 复合只读入口 qq_me：段定义/渲染（纯函数，见 self-view.js）
import { ME_SECTION_IDS, sectionsFor, renderMeView } from './domain/persona/self-view.js';
// [QUANT] 模拟盘量化工具（Phase 2）：只读行情 + 模拟下单 + 决策日记，不碰真钱
// 注意：这几个测试用 `^import .*;` 正则剥 import，**必须写成单行**，否则 vm 里残留语法错误。
import { quantStatus, quantQuote, quantKlines, quantBacktest, quantJournal, quantNote, quantBuy, quantSell } from './quant/agent.js';
import { loadConfig, getConfig, getOneBotConfig, isAllowed, unquoteJsonString, onebot, agentApiBase, readConsoleToken, errText, apiErrorText, agentApi } from './mcp-helpers.js';
import { registerReserved2Tools } from './mcp-reserved2-tools.js';

const cfg = loadConfig();

// 2026-10-25 审计移除：旧只读工具（qq_list_groups / qq_get_group_members /
// qq_get_group_history）与 legacyReadToolAllowed() 已删除。
// 原因：桥接把「x-agent-call 声明」硬化为无活令牌一律 403（confused-deputy 修复，
// bridge.js 的 /api/status 端点门），而无令牌的 /api/status 探测拿不到 mode 字段——
// 判定链在**任何**模式下都走不通，三个工具注册了也只会永远报错（白烧 token 还诱导误调）。
// v2 的带令牌读工具（qq_get_active_members / qq_get_message_detail 等）已覆盖群读能力。

const server = new McpServer({ name: 'snowluma-safe', version: '0.1.7' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const disabledTools = [];
// [TOOL-CATALOG] 工具分层：常驻（核心 + 表情包）+ 分类目录（其余按需展开/调用）。
// 之前 core 模式是"直接不注册"= 对模型不可见；现在改成"收进目录，仍然可发现、可调用"。
// QQ_TOOL_PROFILE=full 时全部直接注册（调试用）。
const TOOL_PROFILE = String(process.env.QQ_TOOL_PROFILE || 'core').toLowerCase();
const CORE_TOOLS = new Set([
  'qq_send_message', 'qq_send_to', 'qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config',
  'qq_get_unread_messages', 'qq_get_recent_messages', 'qq_get_my_recent_messages', 'qq_get_message_images',
  'qq_memory_append', 'qq_person', 'qq_self_wake', 'qq_send_poke', 'qq_slang_judge', 'qq_slang_query', 'qq_slang_submit', 'qq_wish', 'qq_intention',
  // [LEGISLATION] 立法层三件常驻：她给自己立法/拒绝/自评的通道不能藏在目录里
  'qq_promise', 'qq_decline', 'qq_self_assess',
  'qq_resources',
  'qq_cognition_add', 'qq_cognition_update', 'qq_cognition_list',
  'qq_me',
  'qq_get_prompt', 'qq_get_active_members',
  // [QUANT] 只读/低风险三件常驻：快照行会直呼其名，必须真的能直接调（2026-10-28 实测她照做会 not found）。
  // 买卖仍收在 qq_tools 目录里：省 token，也给动钱加一层摩擦。
  'qq_quant_status', 'qq_quant_quote', 'qq_quant_note',
  // 表情包：常用能力，常驻
  'qq_list_stickers', 'qq_sticker_candidates', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
  // 兼容别名（安全测试 / 旧会话）
  'qq_reply', 'qq_send_burst', 'qq_send_private_message', 'qq_send_group_message',
]);
const hiddenTools = new Map(); // name -> { description, params, handler }

// [ERR-NET] 统一兜底：任何 handler 抛出的东西都变成可读文本，绝不让协议层收到未捕获异常。
// 2026-10-28 实测：qq_wait_for_messages 连续 3 次让模型只看到 `Error: [object Object]`——
// 那是 DSH 把非 Error 对象 `${}` 化的结果，模型完全无法据此恢复。
function wrapToolHandler(toolName, handler) {
  if (typeof handler !== 'function') return handler;
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const msg = errText(error);
      try { process.stderr.write(`[tool-error] ${toolName}: ${msg}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-snowluma-safe.js:248'); }
      return { content: [{ type: 'text', text: `工具内部错误（${toolName}）：${msg}` }], isError: true };
    }
  };
}

// 进程级兜底：宁可留一条日志继续服务，也不要让 MCP 子进程静默退出（她那边只会看到连接断开）。
process.on('unhandledRejection', (reason) => {
  try { process.stderr.write(`[unhandledRejection] ${errText(reason)}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-snowluma-safe.js:256'); }
});
process.on('uncaughtException', (error) => {
  try { process.stderr.write(`[uncaughtException] ${errText(error)}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-snowluma-safe.js:259'); }
});

const registerTool = server.tool.bind(server);
server.tool = (name, ...rest) => {
  const toolName = String(name);
  const description = rest[0];
  const params = rest.length >= 3 ? rest[rest.length - 2] : undefined;
  const handler = wrapToolHandler(toolName, rest[rest.length - 1]);
  const wrappedRest = rest.slice(0, -1);
  wrappedRest.push(handler);
  // 显式门控：即使注入的开关表缺失，也必须尊重 slangJudge=false（安全测试要求注册期生效）
  if (toolName === 'qq_slang_judge' && getConfig().socialV2?.tools?.slangJudge === false) {
    disabledTools.push('qq_slang_judge(slangJudge)');
    return undefined;
  }
  const flag = TOOL_CONFIG_FLAGS[toolName];
  if (flag && cfg.socialV2?.tools?.[flag] === false) {
    disabledTools.push(`${toolName}(${flag})`);
    return undefined;
  }
  if (TOOL_PROFILE !== 'full' && !CORE_TOOLS.has(toolName)) {
    hiddenTools.set(toolName, { description, params, handler });
    return undefined;
  }
  return registerTool(name, ...wrappedRest);
};

// 目录工具：分类 → 工具 → 调用，一层层展开，不再需要一次性把所有 schema 发给模型。
registerTool(
  'qq_tools',
  '【工具目录】有些工具没有常驻，按分类收着。用法：① 不传参数 → 列出所有分类；② 只传 category → 列出该分类下的工具和用途；③ 传 tool + arguments → 直接调用那个工具（参数和它的 schema 一致）。',
  {
    category: z.string().optional().describe('分类名（先不带参数调一次，看有哪些分类）'),
    tool: z.string().optional().describe('要调用的工具名（从分类详情里拿）'),
    arguments: z.record(z.any()).optional().describe('该工具的参数对象；需要令牌的工具会自动带上会话令牌，也可以在这里显式传 token'),
    token: z.string().optional().describe('当前会话令牌（可选；省略时用 arguments.token）'),
  },
  async ({ category, tool, arguments: args, token } = {}) => {
    const names = [...hiddenTools.keys()];
    if (!tool) {
      const text = category
        ? renderCategory(names, category, (n) => hiddenTools.get(n)?.description)
        : renderCatalog(names);
      return { content: [{ type: 'text', text }] };
    }
    const entry = hiddenTools.get(String(tool));
    if (!entry) {
      return { content: [{ type: 'text', text: `没有可调用的工具「${tool}」。

${renderCatalog(names)}` }], isError: true };
    }
    try {
      // 顶层 token 合并进参数：减少"忘带令牌 → 未授权"的失败；显式 arguments.token 优先。
      const merged = { ...(args ?? {}) };
      if (token && !merged.token) merged.token = token;
      const result = await entry.handler(merged, {});
      return result ?? { content: [{ type: 'text', text: `已调用 ${tool}（无返回内容）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `调用 ${tool} 失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
// [ME] 复合只读入口：把"我自己的状态"一次取全（自述/今日计划/行为账/认知/长期事实/挂心事）。
// 为什么不拆成 5 个工具：这 5 个在 core profile 下都不常驻，目录里写了她也调不到（只能绕 qq_tools）。
// 一个常驻复合工具只多一份 schema，就把 5 条半通入口收成 1 条；每段独立失败、各自有字数帽。
// 走 server.tool 而不是裸 registerTool：必须和别的工具一样受 profile/开关/错误包装约束，
// 否则 memory=false 时它仍能读 facts/cognition，等于后门。
server.tool(
  'qq_me',
  '一次把自己的状态取全：我写过的、今天给自己定的、最近干过什么、攒下的认知、关于他的长期事实、我挂着的。section 可选一段（self/plan/day/cognition/facts/curiosity），省略=全取；每段有字数帽，超了用 section 单独取。只读，不写任何东西。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    section: z.enum(['all', ...ME_SECTION_IDS]).optional().describe('取哪一段；省略=全取'),
  },
  async ({ key, token, section = 'all' } = {}) => {
    const picked = sectionsFor(section);
    if (!picked.length) {
      return { content: [{ type: 'text', text: `没有这一段：${section}（可选：all/${ME_SECTION_IDS.join('/')}）` }], isError: true };
    }
    const results = [];
    for (const s of picked) {
      try {
        const req = { method: s.method, headers: token ? { 'x-agent-token': token } : {} };
        if (typeof s.body === 'function') req.body = JSON.stringify(s.body(key));
        const data = await agentApi(s.path(key), req);
        results.push({ id: s.id, label: s.label, cap: s.cap, text: serializeModelData(data) });
      } catch (error) {
        results.push({ id: s.id, label: s.label, cap: s.cap, error: errText(error) });
      }
    }
    return { content: [{ type: 'text', text: renderMeView(results) }] };
  }
);
if (TOOL_PROFILE !== 'full') {
  process.nextTick(() => {
    try {
      process.stderr.write(`[tool-profile] core：常驻 ${CORE_TOOLS.size} 个，目录 ${hiddenTools.size} 个（QQ_TOOL_PROFILE=full 全量直发）
`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-snowluma-safe.js:322'); }
  });
}

// [QUANT] 模拟盘量化工具。调用期再查一次开关：注册期过滤解决"看不见"，这里解决"关掉之后还能调"。
function quantToolsOn() {
  return getConfig().socialV2?.tools?.quant !== false;
}
function quantTextResult(r) {
  const ok = r?.ok !== false;
  const text = r?.text ?? r?.reason ?? (ok ? '完成' : '失败');
  return { content: [{ type: 'text', text: ok ? text : `被拒绝：${text}` }], isError: !ok };
}
function quantGuard(tool) {
  if (quantToolsOn()) return null;
  return { content: [{ type: 'text', text: `${tool} 未启用（socialV2.tools.quant=false）。` }], isError: true };
}

server.tool(
  'qq_quant_status',
  '看你的量化模拟盘：净值、现金、持仓、风控上限、今日成交。只读，不联网。',
  {},
  async () => quantGuard('qq_quant_status') ?? quantTextResult(quantStatus())
);

server.tool(
  'qq_quant_quote',
  '查某个币的最新价与 24h 涨跌（默认 BTCUSDT）。只读。',
  { symbol: z.string().optional().describe('交易对，如 BTCUSDT / ETHUSDT') },
  async ({ symbol } = {}) => {
    const g = quantGuard('qq_quant_quote');
    if (g) return g;
    try { return quantTextResult(await quantQuote({ symbol })); } catch (e) { return { content: [{ type: 'text', text: `查价失败：${e?.message ?? e}` }], isError: true }; }
  }
);

server.tool(
  'qq_quant_klines',
  '看最近 K 线的摘要（首尾价、区间高低、涨跌），不返回整段数据。默认 BTCUSDT 1h 24 根。',
  {
    symbol: z.string().optional().describe('交易对'),
    interval: z.string().optional().describe('周期：15m/1h/4h/1d'),
    limit: z.number().optional().describe('根数，2~500，默认 24'),
  },
  async ({ symbol, interval, limit } = {}) => {
    const g = quantGuard('qq_quant_klines');
    if (g) return g;
    try { return quantTextResult(await quantKlines({ symbol, interval, limit })); } catch (e) { return { content: [{ type: 'text', text: `取 K 线失败：${e?.message ?? e}` }], isError: true }; }
  }
);

server.tool(
  'qq_quant_backtest',
  '用历史 K 线回测一个策略，看收益/最大回撤/胜率/手续费。这是历史回放，不代表以后能赚。',
  {
    strategy: z.string().optional().describe('策略名：sma-cross / breakout'),
    symbol: z.string().optional().describe('交易对'),
    interval: z.string().optional().describe('周期：1h/4h/1d'),
    limit: z.number().optional().describe('根数，50~1000，默认 500'),
    fast: z.number().optional().describe('sma-cross 快线'),
    slow: z.number().optional().describe('sma-cross 慢线'),
    lookback: z.number().optional().describe('breakout 回看根数'),
  },
  async ({ strategy, symbol, interval, limit, fast, slow, lookback } = {}) => {
    const g = quantGuard('qq_quant_backtest');
    if (g) return g;
    try {
      const params = {};
      if (Number(fast) > 0) params.fast = Number(fast);
      if (Number(slow) > 0) params.slow = Number(slow);
      if (Number(lookback) > 0) params.lookback = Number(lookback);
      return quantTextResult(await quantBacktest({ strategy, symbol, interval, limit, params }));
    } catch (e) { return { content: [{ type: 'text', text: `回测失败：${e?.message ?? e}` }], isError: true }; }
  }
);

server.tool(
  'qq_quant_buy',
  '模拟盘市价买入（不碰真钱）。notional 是金额（USDT）不是数量；有 30 秒冷却与单仓/日亏/日笔数风控。',
  {
    symbol: z.string().optional().describe('交易对，默认 BTCUSDT'),
    notional: z.number().describe('买入金额（USDT），最低 5'),
  },
  async ({ symbol, notional } = {}) => {
    const g = quantGuard('qq_quant_buy');
    if (g) return g;
    try { return quantTextResult(await quantBuy({ symbol, notional })); } catch (e) { return { content: [{ type: 'text', text: `下单失败：${e?.message ?? e}` }], isError: true }; }
  }
);

server.tool(
  'qq_quant_sell',
  '模拟盘市价卖出（不碰真钱）。qty 传 all 清仓，或传数量。',
  {
    symbol: z.string().optional().describe('交易对，默认 BTCUSDT'),
    qty: z.union([z.string(), z.number()]).optional().describe('卖出数量，或 "all"'),
  },
  async ({ symbol, qty } = {}) => {
    const g = quantGuard('qq_quant_sell');
    if (g) return g;
    try { return quantTextResult(await quantSell({ symbol, qty })); } catch (e) { return { content: [{ type: 'text', text: `卖出失败：${e?.message ?? e}` }], isError: true }; }
  }
);

server.tool(
  'qq_quant_journal',
  '看最近的量化交易与想法记录（她自己的决策日记）。只读。',
  { limit: z.number().optional().describe('条数，默认 20') },
  async ({ limit } = {}) => {
    const g = quantGuard('qq_quant_journal');
    if (g) return g;
    return quantTextResult(quantJournal({ limit }));
  }
);

server.tool(
  'qq_quant_note',
  '把你的判断/理由记一句（为什么买、为什么不买、你怎么看这段行情），下次回看得到。',
  {
    text: z.string().describe('要记的内容，2000 字以内'),
    tags: z.array(z.string()).optional().describe('可选标签，最多 5 个'),
  },
  async ({ text, tags } = {}) => {
    const g = quantGuard('qq_quant_note');
    if (g) return g;
    return quantTextResult(quantNote({ text, tags }));
  }
);

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-snowluma-safe.js:459'); }
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${errText(error)}` }], isError: true };
    }
  }
);

// 旧只读工具 qq_list_groups / qq_get_group_members / qq_get_group_history 已删除（见上方审计注释）。

server.tool(
  'qq_send_group_message',
  '【已合并】这个工具已并入 qq_send_message（当前会话）或 qq_send_to（指定会话）；保留只为兼容旧习惯，新写法请用那两个。 向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填，缺令牌会被桥接拒绝）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '【已合并】并入 qq_send_message（当前会话）/ qq_send_to（指定会话），保留兼容。在指定群引用某条消息并回一句文本：replyToMessageId 为被引用消息 id（非零整数，可负数），可先用 qq_get_recent_messages / qq_get_message_detail 查；桥接会校验 id 属于当前会话。只在两种情况下引用：① 你回的不是最新一条别人的消息；② 同一段话里指代不同消息/不同人。上下文唯一时不要引用。reserved2 下需带 token；目标群须在白名单。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填，缺令牌会被桥接拒绝）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '【已合并】这个工具已并入 qq_send_message（当前会话）或 qq_send_to（指定会话）；保留只为兼容旧习惯，新写法请用那两个。 向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填，缺令牌会被桥接拒绝）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errText(error)}` }], isError: true };
    }
  }
);

registerReserved2Tools(server, cfg);
// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        let imageCount = 0;
        const MAX_TOOL_IMAGES = 6;
        for (const img of images) {
          const frames = Array.isArray(img?.frames) && img.frames.length ? img.frames : null;
          if (frames) {
            textParts.push(`[图片${img.index ?? ''}（动图，抽了 ${frames.length} 帧，原图共 ${img.frameCount ?? frames.length} 帧）]`);
            for (const f of frames) {
              if (imageCount >= MAX_TOOL_IMAGES) { textParts.push('（帧数过多，只返回前几张）'); break; }
              if (f?.data && f?.mimeType) {
                content.push({ type: 'image', mimeType: f.mimeType, data: f.data });
                imageCount += 1;
              }
            }
          } else if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
            imageCount += 1;
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${errText(error)}` }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_sticker_candidates',
    '看看「还没收藏的候选表情」——群里出现过的图，已经有人替你看过并写了描述和适用场景。只是清单：想收哪张再自己 qq_collect_sticker 收进来，不想收就放着。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      count: z.number().optional().describe('最多返回条数，默认 30'),
    },
    async ({ key, token, count }) => {
      try {
        const q = new URLSearchParams({ key, count: String(count || 30) });
        const data = await agentApi(`/api/socialV2/sticker-candidates?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取候选表情失败：${errText(error)}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话单独发一个 QQ 收藏表情包（自定义表情）。两种给法：① stickerId —— 唤醒清单里的短引用（清单写 [a1b2c3d4] 就传 a1b2c3d4），或 qq_list_stickers 的 id / md5 / url；② query —— 按情绪/场景挑一张（无语/安慰/笑死/得意…），多张命中随机挑一张，没命中会把清单还给你（换个词再试）。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；如果这张表情要配一句话，别分两次调用——直接在 qq_send_message 里传 stickerId / stickerQuery，它会把文字和表情一起发掉。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().optional().describe('表情标识：清单短引用（如 a1b2c3d4）/ emoji_id / md5 / URL；与 query 二选一'),
      query: z.string().optional().describe('按情绪/场景挑一张（无语/安慰/笑死/得意…）；与 stickerId 二选一'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, query, replyToMessageId, atUserId }) => {
      if (!stickerId && !query) return { content: [{ type: 'text', text: '要么给 stickerId（清单里的短引用），要么给 query（如「无语」）挑一张。' }], isError: true };
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: stickerId ? String(stickerId) : undefined, query: query ? String(query) : undefined, replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音条（语音库里的音频）。voice 传 qq_list_voices 的 name（可带子目录，文件名可省扩展名）。① 只能发 qq-bridge/audio/ 里的文件，不能发任意路径/URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限拒绝；③ 别滥用，闲聊偶尔一条；④ 返回 verified=true 表示已回读到 record 段，只有 verified=true 才能说"我发了语音"；⑤ readback 只对收到的语音有意义，自己发的默认关闭。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${errText(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${errText(error)}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
