// tool-flags.js · 工具开关的**唯一**来源（2026-10-31 P1-A1）
//
// 之前三处各有一份表：
//   app.mjs 的 SOCIAL_V2_TOOLS_DEFAULTS（运行期默认值）
//   mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS（注册期 tool -> flag）
//   console-server.mjs 的 toolFlags（保存配置时做布尔归一）
// 三份表靠人工同步，漏一个就会「控制台关了、MCP 还在注册」或「默认关闭却仍可见」。
// 现在只维护这一份；三处都 import，测试也只检查这里。
// 发送工具的判定也在这里（SEND_TOOL_NAMES/isSendToolName），避免 app 再写本地正则。
//
// 纪律：本文件只放常量，不 import 任何项目模块，保持 MCP 独立进程可安全加载。
// 新增工具：同时补 SOCIAL_V2_TOOLS_DEFAULTS、TOOL_CONFIG_FLAGS、CONSOLE_TOOL_FLAGS，
// 并更新 README/RULES 与控制台 UI；测试见 test/test-tool-flags.test.mjs。

export const SOCIAL_V2_TOOLS_DEFAULTS = {

getPrompt: true,
getUnread: true,
getRecent: true,
socialState: true,
sendGroup: true,
sendPrivate: true,
reply: true,
sendBurst: true,
sendMessage: true,
waitMessages: true,
feedback: true,
getMyRecent: true,
getMessageDetail: true,
getActiveMembers: true,
setWakeConfig: true,
markRead: true,
memory: true,
slangQuery: true,
slangSubmit: true,
slangJudge: true,
getImages: true,
getForwardMsg: true,
sendPoke: true,
listStickers: true,
getStickerImage: true,
sendSticker: true,
setStickerRemark: false,
stickerNote: true,
collectSticker: true,
getSelfImage: true,
sendVoice: false,
person: true,
curiosity: true,
dayPlan: true,
selfNote: true,
intention: true,
language: true,
hostAction: true,
groupAdmin: false,
wish: true,
// [LEGISLATION] 她有写承诺/拒绝/自我信任的通道（默认开；关掉后 MCP 注册期就看不见）
legislation: true,
selfWake: true,
ownLifeRhythm: true,
myDay: true,
workshop: true,
// [IMAGEGEN] 生图：默认开（后端按需拉起，不常驻，不占资源）；关掉后 MCP 注册期就看不见
image: true,
memoryList: true,
memoryEdit: true,
selfEdit: true,
lessonVote: true,
works: true,
// [QUANT] 模拟盘量化工具总开关：默认开（只是模拟盘）；关掉后 MCP 注册期就看不见
quant: true,
};

export const TOOL_CONFIG_FLAGS = {

qq_get_prompt: 'getPrompt',
qq_get_unread_messages: 'getUnread',
qq_get_recent_messages: 'getRecent',
qq_social_state: 'socialState',
qq_mark_read: 'markRead',
qq_set_wake_config: 'setWakeConfig',
qq_send_group_message: 'sendGroup',
qq_send_private_message: 'sendPrivate',
qq_reply: 'reply',
qq_send_burst: 'sendBurst',
qq_send_message: 'sendMessage',
qq_wait_for_messages: 'waitMessages',
qq_report_feedback: 'feedback',
qq_get_my_recent_messages: 'getMyRecent',
qq_get_message_detail: 'getMessageDetail',
qq_get_active_members: 'getActiveMembers',
qq_memory_append: 'memory',
qq_cognition_add: 'memory',
qq_cognition_list: 'memory',
qq_cognition_update: 'memory',
qq_memory_query: 'memory',
qq_memory_search: 'memory',
qq_memory_remove: 'memory',
qq_memory_clear: 'memory',
qq_me: 'memory',
qq_slang_query: 'slangQuery',
qq_slang_submit: 'slangSubmit',
qq_slang_judge: 'slangJudge',
// [LEGISLATION] 三件立法层工具共用一个开关
qq_promise: 'legislation',
qq_decline: 'legislation',
qq_self_assess: 'legislation',
qq_send_voice: 'sendVoice',
qq_list_voices: 'sendVoice',
qq_image: 'image',
qq_send_image_file: 'image',
// 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
// 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
// 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
// token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
// （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
qq_send_poke: 'sendPoke',
qq_get_message_images: 'getImages',
qq_get_forward_msg: 'getForwardMsg',
qq_list_stickers: 'listStickers',
qq_get_sticker_image: 'getStickerImage',
qq_send_sticker: 'sendSticker',
qq_collect_sticker: 'collectSticker',
qq_get_self_image: 'getSelfImage',
qq_sticker_note: 'stickerNote',
qq_set_sticker_remark: 'setStickerRemark',
// 2026-10-25 审计补齐：person/curiosity/workshop 三个工具此前未登记开关 →
// 控制台永远关不掉（注册期不过滤），但桥接调用期却按 v2ToolEnabled 校验，
// 等于「控制台显示不可操作、模型却带着完整描述看见并调用」。
qq_person: 'person',
qq_curiosity: 'curiosity',
qq_day_plan: 'dayPlan',
qq_self_note: 'selfNote',
qq_intention: 'intention',
qq_language_note: 'language',
host_action: 'hostAction',
qq_workshop: 'workshop',
qq_group_ban: 'groupAdmin',
qq_group_kick: 'groupAdmin',
qq_group_card: 'groupAdmin',
qq_recall: 'groupAdmin',
qq_wish: 'wish',
qq_self_wake: 'selfWake',
qq_set_own_life_rhythm: 'ownLifeRhythm',
qq_my_day: 'myDay',
// [QUANT] 模拟盘量化：一个总开关管 8 个工具；注册期关闭 = 模型完全看不见
qq_quant_status: 'quant',
qq_quant_quote: 'quant',
qq_quant_klines: 'quant',
qq_quant_backtest: 'quant',
qq_quant_buy: 'quant',
qq_quant_sell: 'quant',
qq_quant_journal: 'quant',
qq_quant_note: 'quant',
};

// 当前会话的发送工具：判断「这一回合她开口了吗」。
// 不含 qq_send_to / qq_scene_send：它们发到别的会话，不能代表当前对话已回复。
export const SEND_TOOL_NAMES = Object.freeze([
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_reply',
  'qq_send_burst',
  'qq_send_message',
  'qq_send_poke',
  'qq_send_sticker',
  'qq_send_voice',
  'qq_image',
  'qq_send_image_file',
]);
const SEND_TOOL_NAME_SET = new Set(SEND_TOOL_NAMES);

export function isSendToolName(name) {
  const raw = String(name ?? '');
  const short = raw.startsWith('mcp__snowluma__') ? raw.slice('mcp__snowluma__'.length) : raw;
  return SEND_TOOL_NAME_SET.has(short);
}

// 控制台保存 socialV2.tools 时允许/需要做布尔归一的 flag 顺序。
// 必须覆盖 SOCIAL_V2_TOOLS_DEFAULTS 的全部键；漏一个就会出现「默认表有、保存时被丢掉」。
// [AUDIT-FIX] 由唯一来源派生，杜绝"默认表加了新 flag、控制台清单忘补"的漂移。
export const CONSOLE_TOOL_FLAGS = Object.keys(SOCIAL_V2_TOOLS_DEFAULTS);
