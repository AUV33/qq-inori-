// mcp-tool-catalog.mjs · 可复用的「核心常驻 + 分类目录按需调用」中间件
//
// 为什么：MCP 的每个工具（描述 + 参数 schema）都会随下一次请求完整重发。工具一多，
// 哪怕 7 天只调用过其中十几个，剩下的也一直在烧 token。这里沿用 qq-bridge/src/
// mcp-snowluma-safe.js 已经跑通的模式：
//   1) 核心工具（coreTools）照常注册，模型直接可见、可直接调；
//   2) 其余工具**不注册**，只把描述与 handler 收进隐藏表 —— 模型完全看不见它们的 schema；
//   3) 额外注册一个目录工具（catalogName）：不传参数看分类总览，传 category 看该分类
//      下的工具与用途，传 tool + arguments 直接调用被隐藏的工具。
//
// 与 snowluma 的差异只有一处：分类表由调用方以 `groups` 传入（各服务工具集不同，
// 不适合放一张全局表），本模块不含任何具体工具名，纯通用。
//
// 用法（务必在任何工具注册**之前**调用）：
//   import { installToolCatalog } from '../../shared/mcp-tool-catalog.mjs';
//   const catalog = installToolCatalog(server, {
//     catalogName: 'phone_tools',
//     catalogDescription: '【工具目录】...',
//     coreTools: ['phone_tap', 'phone_text'],
//     groups: { 屏幕操作: ['phone_tap_text', 'phone_key'], 音乐: ['ncm_play'] },
//     describeDefault: (name) => '',   // 可选：工具没有描述时的兜底说明
//   });
//
// 注意：本模块只改「注册面」，不碰任何工具实现。
import { z } from 'zod';

const DEFAULT_CATEGORY = '其他';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{
 *   catalogName: string,
 *   catalogDescription?: string,
 *   coreTools?: string[],
 *   groups?: Record<string, string[]>,
 *   describeDefault?: string | ((name: string) => string),
 * }} options
 */
export function installToolCatalog(server, options = {}) {
  const {
    catalogName = 'tools',
    catalogDescription,
    coreTools = [],
    groups = {},
    describeDefault,
  } = options;

  const core = new Set((Array.isArray(coreTools) ? coreTools : []).map(String));

  // 分类声明保持调用方给的顺序；每组只留字符串工具名。
  const groupOrder = [];
  const groupMembers = new Map();
  for (const [category, list] of Object.entries(groups ?? {})) {
    const cat = String(category);
    const names = (Array.isArray(list) ? list : []).map(String);
    groupOrder.push(cat);
    groupMembers.set(cat, names);
  }

  const fallbackDescribe = typeof describeDefault === 'function'
    ? describeDefault
    : typeof describeDefault === 'string'
      ? () => describeDefault
      : () => '';

  const hiddenTools = new Map(); // name -> { description, params, handler }

  function describe(name) {
    const raw = hiddenTools.get(name)?.description;
    const text = typeof raw === 'string' && raw.trim() ? raw : fallbackDescribe(name);
    return String(text ?? '');
  }

  function categoryOf(name) {
    for (const cat of groupOrder) {
      if (groupMembers.get(cat).includes(name)) return cat;
    }
    return DEFAULT_CATEGORY;
  }

  /** 只列出实际存在（真的被隐藏）的工具：{ 分类: [name...] } */
  function grouped() {
    const out = new Map();
    const seen = new Set();
    for (const cat of groupOrder) {
      const hit = groupMembers.get(cat).filter((n) => hiddenTools.has(n) && !seen.has(n));
      for (const n of hit) seen.add(n);
      if (hit.length) out.set(cat, hit);
    }
    const rest = [...hiddenTools.keys()].filter((n) => !seen.has(n));
    if (rest.length) out.set(DEFAULT_CATEGORY, rest);
    return out;
  }

  const usageCall = `${catalogName}(tool="工具名", arguments={...})`;
  const usageCategory = `${catalogName}(category="分类名")`;

  function renderCatalog() {
    const g = grouped();
    if (!g.size) return '（没有需要按需展开的工具）';
    const total = [...g.values()].reduce((n, list) => n + list.length, 0);
    const lines = [...g].map(([cat, list]) => `- ${cat}（${list.length}）`);
    return [
      `【工具分类】这些工具没有常驻，按分类收着（共 ${total} 个）：`,
      ...lines,
      '',
      '用法：',
      `  ${usageCategory}            → 看这个分类里有哪些工具、各是干什么的`,
      `  ${usageCall} → 直接调用某个工具（arguments 和它原本的参数一致）`,
    ].join('\n');
  }

  /** @returns {{ ok: true, text: string } | { ok: false, text: string }} */
  function renderCategory(category) {
    const g = grouped();
    const tools = g.get(String(category ?? ''));
    if (!tools) {
      const available = [...g.keys()].join('、') || '（无）';
      return { ok: false, text: `没有「${category}」这个分类。可用分类：${available}` };
    }
    const lines = tools.map((name) => `- ${name}：${describe(name).slice(0, 80)}`);
    return {
      ok: true,
      text: [`【${category}】${tools.length} 个：`, ...lines, '', `要调用：${usageCall}`].join('\n'),
    };
  }

  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const toolName = String(name);
    const description = rest[0];
    const params = rest.length >= 3 ? rest[rest.length - 2] : undefined;
    const handler = rest[rest.length - 1];
    if (!core.has(toolName)) {
      hiddenTools.set(toolName, { description, params, handler });
      return undefined;
    }
    return registerTool(name, ...rest);
  };

  const description = catalogDescription || `【工具目录】有些工具没有常驻，按分类收着。用法：① 不传参数 → 列出所有分类；② 只传 category → 列出该分类下的工具和用途；③ 传 tool + arguments → 直接调用那个工具（参数和它原本的 schema 一致）。`;

  registerTool(
    catalogName,
    description,
    {
      category: z.string().optional().describe('分类名（先不带参数调一次，看有哪些分类）'),
      tool: z.string().optional().describe('要调用的工具名（从分类详情里拿）'),
      arguments: z.record(z.any()).optional().describe('该工具的参数对象，字段和它原本的 schema 一致'),
    },
    async ({ category, tool, arguments: args } = {}) => {
      if (!tool) {
        if (!category) return { content: [{ type: 'text', text: renderCatalog() }] };
        const r = renderCategory(category);
        return { content: [{ type: 'text', text: r.text }], ...(r.ok ? {} : { isError: true }) };
      }
      const entry = hiddenTools.get(String(tool));
      if (!entry) {
        return {
          content: [{ type: 'text', text: `没有可调用的工具「${tool}」。\n\n${renderCatalog()}` }],
          isError: true,
        };
      }
      try {
        // [AUDIT-FIX] 隐藏工具绕过了 MCP SDK，注册时保存的 zod params 以前从不解析，
        // 导致各工具声明的 max()/refine()/enum 全部失效。这里在调用前补上校验；
        // parse 失败会被下面 catch 转成 isError，不会把异常抛进 MCP 传输层。
        const parsed = entry.params && typeof entry.params === 'object'
          ? z.object(entry.params).parse(args ?? {})
          : (args ?? {});
        // handler 签名兼容两种：有的 server 是 (args) => ...，有的是 (args, extra) => ...。
        // 统一按 (args, extra) 调用，单参函数会自然忽略第二个参数（与 snowluma 一致）。
        const result = await entry.handler(parsed, {});
        return result ?? { content: [{ type: 'text', text: `已调用 ${tool}（无返回内容）` }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `调用 ${tool} 失败：${error?.message ?? error}` }],
          isError: true,
        };
      }
    },
  );

  return {
    catalogName,
    coreTools: core,
    hiddenTools,
    groupTools: () => Object.fromEntries(grouped()),
    renderCatalog,
    renderCategory: (category) => renderCategory(category),
  };
}
