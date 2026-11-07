// tool-catalog.js · 工具的分层目录（分类 → 工具 → 调用）
//
// 目标：不把 57 个工具一次性塞给模型，而是：
//   1) 常驻工具（发送/等待/已读/记忆写入/表情包…）直接可见；
//   2) 其余工具收进目录，模型先看「有哪些分类」→ 再看「这个分类里有什么」→ 最后按需调用。
//
// 这个模块只负责"分类与描述文本"（纯函数，便于单测）；真正的注册拦截与分发在 MCP server 里。
// 分类是手写的：自动按前缀分会把「记忆整理」和「聊天」混在一起，模型更难选。

export const CATEGORY_MAP = {
  聊天与消息: ['qq_get_message_detail', 'qq_get_forward_msg', 'qq_report_feedback', 'qq_status', 'qq_social_state'],
  跨会话发话: ['qq_scene_send'],
  群管理: ['qq_group_ban', 'qq_group_kick', 'qq_group_card', 'qq_recall'],
  记忆整理: ['qq_memory_query', 'qq_memory_search', 'qq_memory_remove', 'qq_memory_clear', 'memory_list', 'memory_edit'],
  语音: ['qq_list_voices', 'qq_send_voice'],
  自我与工作: ['qq_curiosity', 'qq_day_plan', 'qq_self_note', 'qq_promise', 'qq_decline', 'qq_self_assess', 'host_action', 'qq_tune_self', 'qq_workshop', 'qq_set_own_life_rhythm', 'self_edit', 'self_edit_code', 'work_list', 'work_start', 'work_peek', 'work_note', 'work_update', 'qq_my_day'],
  表情包: ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image', 'qq_set_sticker_remark'],
  // [IMAGEGEN] 生图（模型替她出图，和 phone_sketch 的手画是两回事）
  生图: ['qq_image', 'qq_send_image_file'],
  量化: ['qq_quant_status', 'qq_quant_quote', 'qq_quant_klines', 'qq_quant_backtest', 'qq_quant_buy', 'qq_quant_sell', 'qq_quant_journal', 'qq_quant_note'],
};

/** 工具 → 分类（未知的归"其他"） */
export function categoryOf(toolName) {
  const name = String(toolName ?? '');
  for (const [cat, tools] of Object.entries(CATEGORY_MAP)) {
    if (tools.includes(name)) return cat;
  }
  return '其他';
}

/** 把隐藏工具按分类归并：{ 分类: [name...] }，只保留实际存在的 */
export function groupTools(names) {
  const set = new Set((Array.isArray(names) ? names : []).map(String));
  const out = {};
  for (const [cat, tools] of Object.entries(CATEGORY_MAP)) {
    const hit = tools.filter((t) => set.has(t));
    if (hit.length) out[cat] = hit;
  }
  const rest = [...set].filter((n) => !Object.values(CATEGORY_MAP).some((list) => list.includes(n)));
  if (rest.length) out['其他'] = rest.sort();
  return out;
}

/** 目录总览（分类 + 数量 + 怎么展开） */
export function renderCatalog(names) {
  const grouped = groupTools(names);
  const cats = Object.entries(grouped);
  if (!cats.length) return '（没有需要按需展开的工具）';
  const lines = cats.map(([cat, tools]) => `- ${cat}（${tools.length}）`);
  return [
    '【工具分类】下面这些工具没有常驻，按分类收着：',
    ...lines,
    '',
    '用法：',
    '  qq_tools(category="群管理")            → 看这个分类里有哪些工具、各是干什么的',
    '  qq_tools(tool="qq_recall", arguments={...}) → 直接调用某个工具',
  ].join('\n');
}

/** 单个分类详情（工具名 + 一句话说明） */
export function renderCategory(names, category, describe = () => '') {
  const grouped = groupTools(names);
  const tools = grouped[String(category ?? '')];
  if (!tools) {
    const available = Object.keys(grouped).join('、') || '（无）';
    return `没有「${category}」这个分类。可用分类：${available}`;
  }
  const lines = tools.map((t) => `- ${t}：${String(describe(t) || '').slice(0, 80)}`);
  return [`【${category}】${tools.length} 个：`, ...lines, '', '要调用：qq_tools(tool="工具名", arguments={...})'].join('\n');
}
