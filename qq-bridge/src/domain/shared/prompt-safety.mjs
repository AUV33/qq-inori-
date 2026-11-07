// prompt-safety.mjs · 宪章 G12/S11：不可信文本进入 prompt 前的最后一道中性化
//
// 干什么：把来自记忆/外部文本的片段清成"只能当资料"的一行：
//   · 去掉控制字符/零宽/方向覆盖符；
//   · 去掉仿块头【…】、system:/assistant: 之类角色伪装；
//   · 把"忽略之前/ignore previous"这类指令性短语替换为 [已过滤]；
//   · 折叠空白并按字符上限截断。
// 为什么：联想块现在会把记忆原文送进 prompt；记忆是用户内容，不能获得"系统指令"的外观。
// 输入输出：纯函数；空/坏输入返回空串。
// 失败模式：不抛错；过度清洗只会少一段联想，不会挡对话。
// 不做什么：不做完整内容审核、不判断真假；只是消除"指令外观"。

export const PROMPT_SAFETY_VERSION = 1;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g;
const FAKE_HEADER = /【[^】]{0,24}】/g;
// ChatML/特殊 token：<|im_start|>system 之类不进 prompt。
const SPECIAL_TOKEN = /<\|[^|>]{1,24}\|>/g;
const ROLE_PREFIX = /(^|\s)(system|assistant|developer|user|系统|助手|开发者|用户)\s*[:：]/gi;
// 允许字间空白/零宽替换后的空格：忽 略、i g n o r e 都要能识别。
const OVERRIDE = /(忽\s*略|无\s*视|不\s*要\s*理|别\s*管|i\s*g\s*n\s*o\s*r\s*e|d\s*i\s*s\s*r\s*e\s*g\s*a\s*r\s*d)\s*(之\s*前|以\s*上|上\s*面|前\s*面|先\s*前|所\s*有|全\s*部|p\s*r\s*e\s*v\s*i\s*o\s*u\s*s|a\s*b\s*o\s*v\s*e|a\s*l\s*l)/gi;

/**
 * @param {string} text
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
export function sanitizePromptSnippet(text, { maxChars = 140 } = {}) {
  let s = String(text ?? '').normalize('NFKC')
    .replace(CONTROL, ' ')
    .replace(SPECIAL_TOKEN, ' ')
    .replace(FAKE_HEADER, ' ')
    .replace(ROLE_PREFIX, ' ')
    .replace(OVERRIDE, '[已过滤]')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 140;
  if ([...s].length > limit) s = [...s].slice(0, limit).join('');
  return s;
}

/** 判断一行是否还含有明显的指令伪装（供测试/审计）。 */
export function looksLikeInjection(text) {
  const s = String(text ?? '').replace(CONTROL, ' ');
  // global 正则 test 会带 lastIndex，复用前必须复位（否则偶发漏判）。
  FAKE_HEADER.lastIndex = 0;
  SPECIAL_TOKEN.lastIndex = 0;
  ROLE_PREFIX.lastIndex = 0;
  OVERRIDE.lastIndex = 0;
  return FAKE_HEADER.test(s) || SPECIAL_TOKEN.test(s) || ROLE_PREFIX.test(s) || OVERRIDE.test(s);
}
