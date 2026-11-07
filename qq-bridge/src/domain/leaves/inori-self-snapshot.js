// inori-self-snapshot.js · 自我视图的统一拼装（P1-B 第一步，行为不变）
//
// 现在 wake-sender 里 narrative / profile / self-model 是三段独立字符串，
// 用 [narrative, profile, selfText].filter(Boolean).join('\n\n') 拼起来。
// 这个模块先把「块 + 顺序 + 分隔」固定成数据，后续再逐步把 trend / learning /
// behavior / self-recent 收进来；当前输出与旧拼法逐字节一致。
//
// 纪律：纯函数，不读文件、不碰配置、不改文案。

/**
 * @param {{narrative?: string, profile?: string, model?: string, behavior?: string, learning?: string, trend?: string}} parts
 * @returns {{text: string, blocks: Array<{id:string,text:string}>}}
 */
export function composeSelfSnapshot({
  narrative = '', profile = '', model = '', behavior = '', learning = '', trend = '',
} = {}) {
  // 顺序必须与旧 wake-sender 的「多次 prepend」最终顺序一致：
  // selfModel(narrative/profile/model) → behavior → learning → trend。
  const blocks = [];
  if (narrative) blocks.push({ id: 'narrative', text: String(narrative) });
  if (profile) blocks.push({ id: 'profile', text: String(profile) });
  if (model) blocks.push({ id: 'model', text: String(model) });
  if (behavior) blocks.push({ id: 'behavior', text: String(behavior) });
  if (learning) blocks.push({ id: 'learning', text: String(learning) });
  if (trend) blocks.push({ id: 'trend', text: String(trend) });
  return { text: blocks.map((b) => b.text).join('\n\n'), blocks };
}
