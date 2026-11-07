// inori-persona-cues.js · 个性显现：认出「被夸 / 被损 / 被求助」这几个瞬间
//
// 只递事实 + 许可（接不接、怎么接她自己定），不替她写台词。
// 素材只来自别人的话（incoming），她自己的发言不参与。
const PRAISE = /夸|厉害|好棒|很棒|可爱|喜欢你|爱你|谢谢|辛苦|牛|强啊|太强|贴贴|亲亲|点赞/;
const TEASE = /菜|笨|傻|就这|笑死|不服|你行你上|急了|破防|呵呵|啧|弱|蠢/;
const ASK_HELP = /帮我|帮我做|帮我查|救命|怎么办|教教我|拜托|求你了/;

export function detectPersonaCues(texts) {
  const joined = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '')).join('\n');
  if (!joined.trim()) return [];
  const cues = [];
  if (PRAISE.test(joined)) cues.push('praise');
  if (TEASE.test(joined)) cues.push('tease');
  if (ASK_HELP.test(joined)) cues.push('help');
  return cues;
}

const CUE_TEXT = {
  praise: '他刚在夸你/谢你（你被夸的时候容易别扭——顶一句，或者别扭一下就过去，你定）。',
  tease: '他刚在损你/拱火（你可以损回去，也可以懒得理；怎么接你定）。',
  help: '他在找你帮忙（做不做、帮到哪一步，你定）。',
};

export function renderPersonaCue(texts, { max = 2 } = {}) {
  const cues = detectPersonaCues(texts).slice(0, max);
  if (!cues.length) return null;
  return `【这会儿】${cues.map((c) => CUE_TEXT[c]).join(' ')}`;
}
