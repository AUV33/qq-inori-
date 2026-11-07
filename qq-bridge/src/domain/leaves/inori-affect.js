// [AFFECT] 读别人的心理与感受：只做"线索 → 假设"，不下诊断结论
// 设计纪律（对齐 owner 定案）：
//  1) 判定权归她：模块只递"看起来像什么 + 依据 + 猜错的可能"，不写"你必须安慰他"。
//  2) 事实与推测分开：evidence 是原文片段（事实），affect 是假设（可否认）。
//  3) 不做病名、不贴标签；只在对话尺度内说话（这会儿 / 这句话）。
// 纯函数 + 单测，不读盘、不调模型。

const CLOSED_RE = /^(嗯+|哦+|好+|行+|随便|都行|算了|没事|不说了|知道了|随你)[。.!！…～~]*$/;
const SHUTDOWN_RE = /(算了|不想说|没事了|没什么|不说了|就这样吧|随便你|我无所谓)/;
const GUILT_RE = /(对不起|是我不好|我的错|都怪我|我不该)/;
const ANGER_RE = /(你他妈|烦死|滚吧|凭什么|有病|无语|md|傻|闭嘴|别管我)/i;
const JOKE_RE = /(哈哈+|笑死|草|绷不住|乐死|绷|233+|xd|🐶|狗头)/i;
const SEEK_RE = /(怎么办|我该怎么办|难受|好难过|撑不住|崩溃|想哭|没人|陪我|抱抱|安慰我|睡不着)/;
const PROBE_RE = /(你是不是|是不是我|你是不是觉得|是不是在敷衍|是不是不喜欢|你生气了吗|你是不是不想)/;
const WARM_RE = /(谢谢|真好|开心|喜欢|嘿嘿|抱抱|晚安|早安|幸苦|辛苦)/;
// 群内互怼/起哄常用的词：单看是"带刺"，但在群里+有笑声时多半是玩笑
const BANTER_RE = /(傻蛋|傻狗|傻呗|傻逼|菜鸡|菜狗|蠢|呆|2b|太菜)/i;
const LAUGH_CONTEXT_RE = /(哈哈|笑死|草|乐死|绷|233|狗头|🐶)/i;
const EMOJI_LOW = /[😔😞😟😢😭💔🥲😮‍💨]/u;
const EMOJI_ANGER = /[😡🤬💢👿]/u;

function clean(text) {
  return String(text || '')
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/@\S+/g, '')
    .trim();
}

/**
 * 从"一句话 + 少量上下文"判断对方此刻的状态候选。
 * @param {string} text 对方最后一句
 * @param {{prev?:string[], recentShortReplies?:number, now?:number}} [ctx]
 * @returns {{affect:string, intent:string, confidence:number, evidence:string[], note:string}}
 */
export function detectCues(text, ctx = {}) {
  const raw = clean(text);
  if (!raw) return { affect: '未知', intent: '未知', confidence: 0, evidence: [], note: '没有内容' };

  const evidence = [];
  const add = (re, label) => {
    const m = raw.match(re) || (ctx.prev || []).slice(-2).map((p) => clean(p).match(re)).find(Boolean);
    if (m) { evidence.push(`${label}：“${String(m[0]).slice(0, 12)}”`); return true; }
    return false;
  };

  // 1) 明确求助/倾诉
  if (add(SEEK_RE, '求助/难受') || EMOJI_LOW.test(raw)) {
    const long = raw.length >= 60;
    return {
      affect: long ? '在倾诉' : '不太舒服',
      intent: '想要被接住，未必想要方案',
      confidence: long ? 0.75 : 0.6,
      evidence,
      note: '先接情绪；方案等对方问再说，别急着修问题',
    };
  }
  // 2) 带刺/烦躁 —— 先判两件事：火是不是冲她来的？是不是群里互怼？
  const angerHit = add(ANGER_RE, '带刺') || EMOJI_ANGER.test(raw) || BANTER_RE.test(raw);
  if (angerHit) {
    const directed = ctx.directedAtSelf !== false; // 没给方向就当冲她（保守，但降低置信度）
    const banter = BANTER_RE.test(raw) && (ctx.isGroup !== false) && (LAUGH_CONTEXT_RE.test(raw) || !!ctx.laughInWindow);
    if (banter) {
      return { affect: '在互怼/起哄', intent: '多半是玩笑，不是真气', confidence: 0.55, evidence, note: '可以怼回去，别当真；对方真急会换词的' };
    }
    if (!directed) {
      return { affect: '在冲别人/说别人', intent: '火不在你身上', confidence: 0.5, evidence, note: '别自动对号入座；要接就接事实，不接火气' };
    }
    return { affect: '烦躁/带火', intent: '可能被什么硌到了（也可能冲你）', confidence: 0.65, evidence, note: '别顶回去，也别立刻道歉；先问一句怎么了' };
  }
  // 3) 关闭/失望
  if (add(SHUTDOWN_RE, '收住不说') || (CLOSED_RE.test(raw) && Number(ctx.recentShortReplies) >= 2)) {
    return { affect: '低落/不想说了', intent: '嘴上说没事，可能在退', confidence: 0.65, evidence, note: '这时候追问会把人推远；可以说“我在”，别逼问' };
  }
  // 4) 试探
  if (add(PROBE_RE, '试探')) {
    return { affect: '不安/在确认', intent: '想知道自己重不重要', confidence: 0.7, evidence, note: '给确定的话，别绕，也别反问' };
  }
  // 5) 玩笑/调侃
  if (add(JOKE_RE, '玩笑') || /\[图片\]/.test(raw)) {
    return { affect: '放松/在玩', intent: '逗一逗', confidence: 0.55, evidence, note: '可以接梗；别一本正经' };
  }
  // 6) 内疚
  if (add(GUILT_RE, '自责')) {
    return { affect: '内疚', intent: '想被原谅/想被接住', confidence: 0.65, evidence, note: '别加重他的错，也别轻飘飘说没事' };
  }
  // 7) 暖/亲近
  if (add(WARM_RE, '亲近')) {
    return { affect: '亲近/心情不错', intent: '想靠近', confidence: 0.5, evidence, note: '接住就好，不用升华' };
  }
  // 8) 短句硬句号（无更多证据时只给弱假设）
  if (CLOSED_RE.test(raw)) {
    return { affect: '可能有点闷', intent: '不确定', confidence: 0.35, evidence: ['极简回复：“' + raw.slice(0, 8) + '”'], note: '证据弱，别当结论' };
  }
  return { affect: '平稳', intent: '正常说话', confidence: 0.3, evidence: [], note: '没有明显情绪线索' };
}

/**
 * 把一个时间窗里同一个人的几句话聚一下：只看"最近 3 条"，避免把旧情绪一直挂着。
 * @param {{text:string, at?:number, isSelf?:boolean}[]} messages
 * @param {{now?:number, windowMs?:number}} [opts]
 */
export function aggregateFeel(messages = [], opts = {}) {
  const now = Number(opts.now) || Date.now();
  const windowMs = Number(opts.windowMs) || 10 * 60 * 1000;
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.isSelf && clean(m.text))
    .filter((m) => !m.at || now - Number(m.at) <= windowMs)
    .slice(-3);
  if (!list.length) return { affect: '未知', confidence: 0, evidence: [], note: '窗口内没内容' };

  const short = list.filter((m) => clean(m.text).length <= 3).length;
  const last = detectCues(list[list.length - 1].text, {
    prev: list.slice(0, -1).map((m) => m.text),
    recentShortReplies: short,
    directedAtSelf: opts.directedAtSelf,
    isGroup: opts.isGroup,
    laughInWindow: (Array.isArray(messages) ? messages : []).some((m) => m && !m.isSelf && LAUGH_CONTEXT_RE.test(clean(m.text))),
  });
  // 多条都短 → 提高"关闭"的置信度
  if (short >= 2 && /闷|低落/.test(last.affect)) {
    return { ...last, confidence: Math.max(last.confidence, 0.6), evidence: [...last.evidence, `窗口内 ${short} 条都很短`] };
  }
  return last;
}

/** 渲染成提示块；返回空串表示不注入（证据太弱就不打扰她） */
export function renderFeelHint(result, { who = '对方', minConfidence = 0.5 } = {}) {
  if (!result || Number(result.confidence) < minConfidence) return '';
  const ev = (result.evidence || []).slice(0, 2).join('；');
  const lines = [
    `【${who}这会儿看起来】${result.affect}`,
    ev ? `依据：${ev}` : '',
    `我的猜测（可能错）：${result.intent}`,
    result.note ? `可以这样想：${result.note}` : '',
    '——不对就当没看见，按你自己的判断来',
  ].filter(Boolean);
  return lines.join('\n');
}
