// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

// [WALL-TOOL] 工具边界可被「她申请、主人一句话」扩展：
// owner 侧文件 state/tool-whitelist.json（data 区，热读、按 mtime 重载）：
//   { extraExact: string[], extraPrefixes: string[], denied: string[] }
// - extraExact / extraPrefixes：经批准的放开（她 propose grant → owner approve）
// - denied：她自拒（propose deny 立即生效，不需要批准）
// 执行期 guard 每次工具调用都热读文件；注册期 restrict 只反映 apply() 时刻的内容
//（本地工具进 schema 另需 DSH 重启，属 owner 侧操作）。
import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 白名单文件默认取插件所在仓库（<repo>/qq-bridge/plugins/qq-agent-presets → <repo>/qq-bridge/state）。
// 插件被拷到别处时用 MZ_TOOL_WHITELIST 指路。
export const TOOL_WHITELIST_FILE = process.env.MZ_TOOL_WHITELIST
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../state/tool-whitelist.json')
let _toolWhitelistCache = { mtimeMs: 0, data: null }
export function loadToolWhitelist() {
  const EMPTY = { extraExact: [], extraPrefixes: [], denied: [] }
  try {
    const st = fs.statSync(TOOL_WHITELIST_FILE)
    if (_toolWhitelistCache.data && _toolWhitelistCache.mtimeMs === st.mtimeMs) return _toolWhitelistCache.data
    let rawText = fs.readFileSync(TOOL_WHITELIST_FILE, 'utf8')
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1) // 防 BOM
    const raw = JSON.parse(rawText)
    _toolWhitelistCache = {
      mtimeMs: st.mtimeMs,
      data: {
        extraExact: Array.isArray(raw.extraExact) ? raw.extraExact : [],
        extraPrefixes: Array.isArray(raw.extraPrefixes) ? raw.extraPrefixes : [],
        denied: Array.isArray(raw.denied) ? raw.denied : [],
      },
    }
    return _toolWhitelistCache.data
  } catch {
    return EMPTY
  }
}

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // [手工添加] QQ 空间：她自己发说说/看动态/点赞/评论。
  // 注意这是「发出去撤不回」的类别，qzone-mcp 内建了频率限制，别去掉。
  'mcp__qzone__',
  // [手工添加] 她自己的日记（只写/只读，无删除）
  'mcp__diary__',
  // [手工添加] 手机操作（34 个工具）。⚠️ 别接带支付/银行 App 的主力机
  'mcp__phone__',
  // [手工添加] 长期记忆（按人存；写入前查重；字符二元组相关度）
  'mcp__memory__',
  // [手工添加] 明日方舟知识（只读：PRTS wiki 搜索/页面 + 本地游戏数据）。
  // 2026-10-30 试跑：她打不过不是手不灵，是不知道这关该带谁/放什么技能。
  'mcp__prts__',
]

/**
 * [一档开放] 执行期放行的本地**只读**工具。v2 preset 仅以只读配置挂载
 * （write/edit/readImage 全关，shell/进程/派生 agent 不挂），所以放行它们是
 * "只能看"的边界；测试用这个常量把例外钉死，防止悄悄扩大。
 */
export const READ_ONLY_TOOLS = Object.freeze(['read', 'glob', 'grep'])

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  // [一档开放 2026-10-25] 本地只读三件套：v2 preset 以 config 关掉 write/edit/readImage
  // 的方式挂 dsh-tool-fs / dsh-tool-fs-search（scoped，注册期白名单放行）；
  // LOCAL_EXECUTION_TOOLS 里仍保留这三个名字的 restrict deny（只防「它们被注册进
  // 全局层」的回归，scoped 工具不受 restrict 影响，两者不矛盾）。
  // 注意：write/edit/read_image **故意不在**此名单——v2 根本没挂，admin preset 另有
  // 自己的 restrict（qq-tool-restrict-admin.mjs）。
  ...READ_ONLY_TOOLS,
])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏。
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`)
    }
  }

  // [WALL-TOOL] 注册期也尊重 owner 侧白名单里已批准的「收紧」denied（新会话生效）：
  const registrationWhitelist = loadToolWhitelist()
  for (const name of registrationWhitelist.denied) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      console.error(`[qq-tool-restrict] skip restrict (denied) ${name}: ${error?.message ?? error}`)
    }
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    const wl = loadToolWhitelist()
    if (wl.denied.includes(name)) return `工具 "${name}" 已被停用，已拒绝`
    if (wl.extraExact.includes(name)) return
    if (wl.extraPrefixes.some((prefix) => name.startsWith(prefix))) return
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    if (READ_ONLY_TOOLS.includes(name)) return
    return `工具 "${name}" 不在白名单内，已拒绝`
  })
}
