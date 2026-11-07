// config-schema.js · socialV2 的启动期轻量类型校验（不新增依赖）
//
// 目标不是替代 JSON Schema，而是把“配置写错类型”从静默回默认变成一条明确告警：
// 例如 socialV2.wait 写成字符串、tools 写成数组、enabled 写成 "false"。
// 校验失败只 warn，不阻断 24/7 启动；真正的 merge 由 config-merge.js 做。

const OBJECT_SECTIONS = [
  'wake', 'send', 'wait', 'secretary', 'sticker', 'proactive', 'feedback', 'context',
  'voice', 'memory', 'memoryInject', 'aboutSelf', 'atSplit', 'affect', 'taskPool',
  'tools', 'gate', 'style', 'relationship', 'groupHabits', 'cognition',
];

const NUMBER_KEYS = ['autoReplyCheckMs', 'maxReplyChars'];
const BOOLEAN_KEYS = ['enabled', 'paused'];

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSocialV2Config(socialV2) {
  const errors = [];
  if (!isPlainObject(socialV2)) return { ok: false, errors: ['socialV2 必须是对象'] };
  for (const key of BOOLEAN_KEYS) {
    if (socialV2[key] !== undefined && typeof socialV2[key] !== 'boolean') {
      errors.push(`socialV2.${key} 应为 boolean，实际 ${typeof socialV2[key]}`);
    }
  }
  for (const key of NUMBER_KEYS) {
    if (socialV2[key] !== undefined && typeof socialV2[key] !== 'number') {
      errors.push(`socialV2.${key} 应为 number，实际 ${typeof socialV2[key]}`);
    }
  }
  for (const key of OBJECT_SECTIONS) {
    if (socialV2[key] !== undefined && !isPlainObject(socialV2[key])) {
      errors.push(`socialV2.${key} 应为对象，实际 ${Array.isArray(socialV2[key]) ? 'array' : typeof socialV2[key]}`);
    }
  }
  if (socialV2.tools !== undefined && isPlainObject(socialV2.tools)) {
    for (const [key, value] of Object.entries(socialV2.tools)) {
      if (typeof value !== 'boolean') errors.push(`socialV2.tools.${key} 应为 boolean，实际 ${typeof value}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
