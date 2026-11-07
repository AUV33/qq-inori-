// inori-behavior-log.mjs · 她"做过什么"的可读账本（纯函数，零 IO）
//
// 数据源：state/tool-calls.jsonl（每次工具调用一行：{type:'call', time, key, tool, sessionId}）
// 用途：①唤醒时注入一行「我最近做过的」；②每天一条 digest 存 data/state/behavior-log.jsonl。
// 纪律：只报事实与次数，不评价；没有数据就不出这一行。

const CATS = [
  { name: '说话', match: /^qq_(send|reply|send_burst|send_message|send_burst|send_poke|send_sticker|scene_send)/ },
  { name: '等消息', match: /^qq_wait_for_messages$/ },
  { name: '翻消息', match: /^qq_(get_unread|get_recent|mark_read|get_message_detail|get_my_recent|get_active_members|get_images|get_forward_msg)/ },
  { name: '记忆', match: /^(memory_|qq_memory)/ },
  { name: '学习', match: /^(lesson_|skill_|trace_log|qq_slang)/ },
  { name: '手机', match: /^phone_/ },
  { name: '上网', match: /^(web_search|web_fetch|browse_)/ },
  { name: '做事', match: /^(handoff_task|work_|goal_|qq_quant)/ },
  { name: '空间', match: /^qzone_/ },
];

/** 工具名归一：mcp__snowluma__qq_send_message → qq_send_message */
export function baseToolName(tool) {
  const t = String(tool || '');
  const i = t.lastIndexOf('__');
  const base = i >= 0 ? t.slice(i + 2) : t;
  return base.replace(/^mcp_/, '');
}

export function categoryOf(tool) {
  const base = baseToolName(tool);
  for (const c of CATS) if (c.match.test(base)) return c.name;
  return '其他';
}

/**
 * @param {Array} rows tool-calls 行
 * @param {{key?:string, days?:number, now?:number}} opts
 */
export function summarizeBehavior(rows, { key = '', days = 1, now = Date.now() } = {}) {
  const windowMs = Math.max(1, Number(days) || 1) * 86400000;
  const cutoff = Number(now) - windowMs;
  const byCategory = {};
  let total = 0;
  const toolCount = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.type !== 'call') continue;
    if (key && String(r.key || '') !== String(key)) continue;
    const at = Date.parse(r.time || '');
    if (!Number.isFinite(at) || at < cutoff) continue;
    const cat = categoryOf(r.tool);
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const base = baseToolName(r.tool);
    toolCount[base] = (toolCount[base] || 0) + 1;
    total += 1;
  }
  return { total, days: Math.max(1, Number(days) || 1), byCategory, toolCount };
}

/** 渲染一行可注入文本；没有动作返回 '' */
export function renderBehaviorLogLine(stats) {
  const total = Number(stats?.total) || 0;
  if (!total) return '';
  const parts = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} 次`);
  return `【我最近做过的】最近 ${stats.days * 24} 小时，我动了 ${total} 次手（${parts.join('、')}）。`;
}

/** 每天一条 digest（供 behavior-log.jsonl 落盘） */
export function behaviorDigestRow(stats, { key = '', now = Date.now() } = {}) {
  const d = new Date(Number(now) || Date.now());
  return {
    day: d.toLocaleDateString('sv-SE'),
    key: String(key || ''),
    at: d.toISOString(),
    total: Number(stats?.total) || 0,
    byCategory: stats?.byCategory || {},
  };
}
