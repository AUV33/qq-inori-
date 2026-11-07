// inori-live-feedback.js · 实时反馈（纯函数，零 IO）
//
// 目的：工具报错时给下一步一句可执行的换法；用户纠正时识别出来，交给 session-notes。
// 纪律：只给一个动作、不超过 80 字；不在这里写经验、不改角色卡、不替她做决定。

const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

/** 用户这句话像不像“纠正/规则”，不是随口否定。 */
export function looksLikeCorrection(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || [...t].length > 160) return false;
  const patterns = [
    /不是这样/, /不是让你/, /不是这个意思/, /你搞错/, /我说的是/, /谁让你/,
    /别这样/, /不要这样/, /以后别/, /下次别/, /别再/,
    /你应该/, /应该先/, /记住/, /要记得/,
    /先.{0,12}再.{0,12}/, /别急着/,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * 工具错误分类 + 换法提示。
 * @param {string} tool
 * @param {string} errorText
 * @returns {{kind:string, hint:string}}
 */
export function classifyToolError(tool = '', errorText = '') {
  const s = String(errorText ?? '');
  const lower = s.toLowerCase();
  const t = String(tool || '').replace(/^mcp__[^_]+__/, '');

  if (/无权|权限|denied|permission|not allowed|未启用|403|forbidden|工具未启用/.test(lower)) {
    return { kind: 'permission', hint: '这个工具被拦了：别原样重试，换一个已启用的工具，或如实告诉她。' };
  }
  if (/timeout|timed out|超时|ETIMEDOUT|等待.*超时/.test(lower)) {
    return { kind: 'timeout', hint: '超时了：别立刻重试；先看它是不是还在跑，等一轮或换方法。' };
  }
  if (/not found|不存在|找不到|404|no such|没有这个|未找到/.test(lower)) {
    return { kind: 'notfound', hint: '没找到：先确认名字/路径/群号，只改这一个参数再试。' };
  }
  if (/fetch failed|econn|enotfound|network|网络|连接失败|connect/.test(lower)) {
    return { kind: 'network', hint: '网络断了：先停一下，换个来源或稍后再试，别连续重试。' };
  }
  if (/json|parse|参数|invalid|schema|类型|格式/.test(lower)) {
    return { kind: 'args', hint: '参数格式不对：检查括号/引号/字段名，只改这一处再试。' };
  }
  if (/点不到|没反应|坐标|屏幕|element|控件|界面|dump|ocr|截图/.test(lower) || /phone_(tap|swipe|macro|open_app)/.test(t)) {
    return { kind: 'ui', hint: '界面没对上：先 phone_dump / phone_look 看清再点，同一坐标别点第三次。' };
  }
  if (/没打成|失败|全灭|0 星|漏怪|没放上|卡住/.test(s)) {
    return { kind: 'outcome', hint: '这次没成：记下卡在哪，下一次只改一个变量，别把整套重来。' };
  }
  return { kind: 'unknown', hint: '报错了：先停一下，换一个变量再试；别原样重试。' };
}

/**
 * 渲染一句实时提示；streak 是同一工具+同一错误的连续次数。
 * @param {{tool?:string,error?:string,streak?:number}} opts
 */
export function renderLiveHint({ tool = '', error = '', streak = 1 } = {}) {
  const c = classifyToolError(tool, error);
  if (Number(streak) >= 3) {
    return clip('同一动作已经失败 3 次了：停手，换方法或先问她；不要再原样重试。', 80);
  }
  return clip(c.hint, 80);
}

/** 从错误文本里判断是否值得记进 session-notes（避免把普通噪声写进去）。 */
export function shouldNoteToolFailure(tool, errorText) {
  const c = classifyToolError(tool, errorText);
  return c.kind !== 'unknown' || /失败|卡住|没成/.test(String(errorText ?? ''));
}

/** 把工具错误压成一条 openLoop 文案。 */
export function openLoopText(tool, errorText) {
  const t = String(tool || '').replace(/^mcp__[^_]+__/, '') || '工具';
  const e = clip(String(errorText ?? '').replace(/\s+/g, ' '), 90);
  return `${t} 报错：${e}`;
}
