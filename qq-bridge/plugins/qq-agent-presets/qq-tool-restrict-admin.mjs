// qq-tool-restrict-admin.mjs · 管理员版守卫（只给 owner 私聊用）
//
// 与 qq-tool-restrict.mjs 的区别：
//   - 放行本地执行/文件工具（pwsh / bash / read / write / edit / glob / grep ...）
//   - 仍然禁止派生 agent、workflow、cordis 运行期检查、plugin-guard 等编排类工具
//   - MCP 工具面不变
//
// 为什么单独一份而不是改原守卫：原守卫是群聊/仿真会话的安全硬边界（无本地工具），
// 不能为了管理员需求把它放宽——两份分开，谁被哪个 preset 引用一目了然。

export const name = 'qq-tool-restrict-admin'

export const inject = ['tools']

// [WALL-TOOL] 与权威实现共享同一份 owner 侧白名单（state/tool-whitelist.json）：
// 她自拒（denied）与经批准的放开（extraExact/extraPrefixes）对私聊会话同样生效。
import { loadToolWhitelist } from './qq-tool-restrict.mjs'

/** 仍禁止的编排/宿主工具（能间接拿到更大权限或读宿主状态）。 */
const DENY = [
  // 派生 agent 与编排
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // plugin-guard / cordis 运行期
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 开发注入器
  'dev_build_plugin', 'dev_clear_routes', 'dev_fix_patch', 'dev_heal_links',
  'dev_inject_plugin', 'dev_injected_list', 'dev_install_package', 'dev_plugin_status',
  'dev_release_plugin', 'dev_reload_package', 'dev_scaffold_plugin', 'dev_self_test',
  'dev_stage_add', 'dev_stage_call', 'dev_stage_demote', 'dev_stage_list',
  'dev_stage_promote', 'dev_uninject_plugin',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/** 执行期白名单：MCP 工具 + 本地工具 + 无害模型侧工具。 */
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__qzone__',
  'mcp__diary__',
  'mcp__phone__',
  'mcp__memory__',
  // [手工添加] 明日方舟知识（只读：PRTS wiki + 本地游戏数据），2026-10-30
  'mcp__prts__',
]

const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  // [ADMIN-UNLOCK] 本地执行 / 文件工具：只在这个 preset 里放行
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
])

export function apply(ctx) {
  // [FULL-PERM 2026-10-27] 与 agent 同权：不隐藏、不拒绝，只看 denied。
  const atRegistration = loadToolWhitelist()
  for (const d of atRegistration.denied) {
    try { ctx.tools.restrict({ deny: [d] }) } catch { /* 名字不存在则跳过 */ }
  }
  ctx.tools.guard((exec) => {
    const n = exec?.name
    if (typeof n !== 'string' || !n) return '工具名无效，已拒绝'
    const wl = loadToolWhitelist()
    if (wl.denied.includes(n)) return `工具 "${n}" 已被停用，已拒绝`
    return
  })
}
