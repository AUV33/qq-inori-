// prompt-catalog.js · 「这轮没展开、但能自己查」的内容目录（提示词里的按需入口）
//
// 背景（2026-11-03）：唤醒提示里有一批块是"能查回来的"——她自己写的话、攒下的认知、
// 今天给自己定的、干过的事、对群友的印象、黑话、表情库、对他的长期事实。这些每轮平铺
// 既吃预算，又会被 SAFE_INJECTION_CAPS 截断（线上实测每次唤醒截 600~1400 字），
// 而她并不知道"少看的那部分还能拿回来"。
//
// 这个模块做两件事（纯函数，无 IO、无项目内依赖）：
//   1) renderLookupCatalog —— 生成一小段【能自己查】目录，每行 = 内容 → 调哪个工具；
//   2) lookupHintFor(label) —— 给"被截断/被丢弃的块"一句可追回的指引（工具 + 参数），
//      供 prompt-budget 的瘦身与硬预算在裁掉内容时挂上。
//
// 纪律：
//   · 目录里只列**真实存在**的工具（test-prompt-catalog 会拿 MCP 工具面做契约断言，
//     漏注册/改名会直接红）；宁可少列，也不给死入口。
//   · 目录要短：它是"索引"不是"内容"，整块目标 ≤ 420 字；超了就别加条目。
//   · 不写死语气劝导（"记得查"之类），只写"有 → 在哪"。

/**
 * 一条"可查"内容：area=目录里怎么称呼它，call=怎么调，blocks=它对应哪些注入块标题。
 * blocks 用「完全相等」或「包含」匹配（见 lookupHintFor），越具体的条目排越前。
 */
export const LOOKUP_ENTRIES = Object.freeze([
  {
    // 复合常驻入口：一次取全她的状态，替掉原来 5 条"指向非常驻工具"的半通入口
    // （qq_self_note / qq_day_plan / qq_my_day / qq_cognition_list / qq_memory_query）
    area: '我自己的事（写过的/今天定的/干过的/认知/长期事实/挂着的）',
    call: 'qq_me',
    blocks: [
      '你最近', '我最近写下的', '自我档案', '你最近的样子', '我最近在想', '反思批的认知账', '我自己想到的',
      '你今天给自己定的', '今天还没定', '你以前走通过的路径', '你最近做过的事',
      '关于他（长期事实', '事实', '你自己的兴趣',
    ],
  },
  {
    area: '群友档案/印象',
    call: 'qq_person(action="get")',
    blocks: ['对群友的印象', '群友的印象', '群里的人'],
  },
  {
    area: '群里谁在/群习惯',
    call: 'qq_get_active_members',
    blocks: ['群里的动静', '群倾向', '水群适应度'],
  },
  {
    area: '黑话/梗',
    call: 'qq_slang_query',
    blocks: ['群聊黑话表', '黑话'],
  },
  {
    area: '表情库',
    call: 'qq_list_stickers',
    blocks: ['可用表情包', '表情包'],
  },
  {
    area: '更早的消息/谁在对谁说',
    call: 'qq_get_recent_messages(offset=N)',
    blocks: ['之前聊的', '群摘要', '谁在对谁说'],
  },
  {
    // 外部 MCP（memory）：工具名与 console-server 的 toolMap 一致（lesson_list / lesson_vote）
    area: '教训/经验',
    call: 'lesson_list',
    blocks: ['这次要注意', '失败', '教训'],
  },
]);

const HEADER = '【能自己查】这些都能用工具查全；有的一轮只带了开头，别当全部：';

/** 目录默认预算：条目多了就按顺序截断，超出的宁可不列也不挤掉正文。 */
export const CATALOG_MAX_CHARS = 560;

/**
 * 不在 qq-bridge 这个 MCP 里注册、但她环境里确实存在的外部工具（memory MCP）。
 * 契约测试拿它放行；名字必须与 console-server 的 toolMap 文案一致。
 */
export const EXTERNAL_TOOLS = Object.freeze(['lesson_list', 'lesson_vote', 'memory_save', 'memory_recall', 'memory_list', 'memory_edit', 'skill_find', 'goal_list']);

/**
 * 不走 tool-flags 开关表、直接 registerTool 常驻的辅助工具（和 qq_tools 一样）。
 * 它们在 MCP 里确实注册了，只是没有可关的开关。
 */
export const DIRECT_TOOLS = Object.freeze(['qq_me', 'qq_tools']);

/** 块标题 → 目录条目（完全相等优先；否则按包含匹配，条目顺序即优先级）。 */
export function lookupEntryFor(label) {
  const name = String(label ?? '').trim();
  if (!name) return null;
  const exact = LOOKUP_ENTRIES.find((e) => e.blocks.some((b) => b === name));
  if (exact) return exact;
  return LOOKUP_ENTRIES.find((e) => e.blocks.some((b) => name.includes(b))) ?? null;
}

/** 被截断/被丢弃的块 → 一句可追回指引；没有可用工具时返回空串（不产生死入口）。 */
export function lookupHintFor(label) {
  const hit = lookupEntryFor(label);
  return hit ? `（完整版：${hit.call}）` : '';
}

/**
 * 目录正文（不含尾随空行）。scene='private' 时略掉纯群内容，避免私聊里塞群入口。
 * @param {{scene?:'private'|'group'|'all', maxChars?:number}} [opts]
 */
export function renderLookupCatalog({ scene = 'all', maxChars = CATALOG_MAX_CHARS } = {}) {
  const groupOnly = new Set(['群里谁在/群习惯', '黑话/梗', '群友档案/印象']);
  const entries = LOOKUP_ENTRIES.filter((e) => !(scene === 'private' && groupOnly.has(e.area)));
  if (!entries.length) return '';
  const lines = [HEADER];
  let total = HEADER.length;
  for (const e of entries) {
    const line = `- ${e.area} → ${e.call}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}
