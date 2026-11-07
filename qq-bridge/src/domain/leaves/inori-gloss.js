// inori-gloss.js · 未知词检测（她要学的网络短语/梗）
//
// 问题：提示词里写「偶尔搜一下梗」，结果就是永远不搜。必须由 harness 主动把清单递到她面前。
// 做法：从最近的对话里找出「出现≥N 次、但 lessons 里没有」的词，生成待查清单。
//
// 环境无分词器（不装 jieba），所以用启发式：
//   · 拉丁缩写/字母串（yyds / xswl / hhhh）—— 长度 2~8
//   · 中文 2~4 字的连续片段，且不在常见词白名单里
//   · 统计"出现在多条消息里"的次数（同一句重复不算）
//
// 纯函数、零依赖。

const STOP = new Set([
  '我们', '你们', '他们', '什么', '怎么', '就是', '这个', '那个', '现在', '今天', '明天', '昨天',
  '可以', '没有', '不是', '因为', '所以', '但是', '还是', '已经', '如果', '自己', '知道', '觉得',
  '一个', '一点', '一下', '时候', '东西', '事情', '问题', '真的', '应该', '可能', '这样', '那样',
  '哈哈', '呵呵', '嗯嗯', '好的', '谢谢', '对于', '然后', '而且', '或者', '还有', '不过', '其实',
  '另外', '以及', '需要', '感觉', '想想', '看看', '试试', '一定', '比较', '特别', '有点', '一些',
  '这么', '那么', '反正', '总之', '于是', '之后', '之前', '期间', '左右', '里面', '外面', '下面',
  '上面', '这边', '那边', '这里', '那里', '目前', '直接', '重新', '再次', '继续', '开始', '结束',
  '完成', '确认', '确定', '检查', '注意', '提醒', '消息', '回复', '操作', '界面', '按钮', '设置',
  '功能', '状态', '进度', '情况', '原因', '结果', '方法', '步骤', '过程', '内容', '信息', '数据',
  '文件', '链接', '地址', '名字', '名称', '类型', '制造', '贸易', '技能', '干员', '编队', '轮换',
  '安排', '效率', '产出', '资源', '材料', '数量', '手机', '电脑', '游戏', '账号', '密码',
  '喜欢', '图片', '表情', '链接', '视频', '语音', '转发', '引用', '拍一', '一拍', '戳了戳', '拍一拍', '丢失',
]);

// [GLOSS-QUALITY] 分词碎屑挡板：功能字组成的两字串（"那些/那我/么的"）和助词结尾的
// 片段（"党了/完了"）都不是词，不能当"她可能没见过的词"递给她。
const FUNCTION_CHARS = new Set('的了是在有和与或把被给让很太更最不没要会能可说做看想去来上下里外中大小多少好坏真假对错前后左右高低长短时分秒年月日天早晚夜点个件次些位名家只条张本种样般如果因为所以但是而且或者以及等呢吧吗啊哦嗯哈呀啦嘛呗我你他她它这那哪某每各们');
const PARTICLES = new Set('的了吗吧呢啊哦嗯哈呀啦嘛呗');
const PRONOUNS = /^[我你他她它这那哪某每各们]/;
const isCJK = (c) => c >= '\u4e00' && c <= '\u9fff';

/** 从一句话里抽出候选词（拉丁串 + 带词界信号的中文 2 字词） */
export function extractTerms(text) {
  // [GLOSS-QUALITY] 先剥掉占位符/事件标记（[图片]/【拍一拍】等），否则会被切出"图片/拍一"这类碎屑。
  const s = String(text ?? '').replace(/\[[^\]]{1,12}\]/g, ' ').replace(/【[^】]{1,12}】/g, ' ');
  const out = new Set();
  // 拉丁缩写 / 字母串（梗和缩写大多在这）
  for (const m of s.matchAll(/[A-Za-z]{2,8}/g)) {
    const w = m[0].toLowerCase();
    if (!/^(https?|www|com|cn|jpg|png|mp4|exe|dll|txt|json|mjs|js|py|log|adb)$/.test(w)) out.add(w);
  }
  // [GLOSS-FIX] 中文只取 2 字且至少一边是词界（句首/句尾/标点/空格/数字/字母）：
  // 纯嵌在汉字串里的 2 字片段（"另外就"/"外就是"/"动基建"）是切出来的碎屑，不是词，丢掉。
  for (let i = 0; i + 1 < s.length; i++) {
    if (!isCJK(s[i]) || !isCJK(s[i + 1])) continue;
    const before = i > 0 ? s[i - 1] : '';
    const after = i + 2 < s.length ? s[i + 2] : '';
    const hasBoundary = !before || !isCJK(before) || !after || !isCJK(after);
    if (!hasBoundary) continue;
    const w = s.slice(i, i + 2);
    if (STOP.has(w)) continue;
    // [GLOSS-QUALITY] 碎屑过滤
    if (FUNCTION_CHARS.has(w[0]) && FUNCTION_CHARS.has(w[1])) continue;
    if (PARTICLES.has(w[1])) continue;
    if (PRONOUNS.test(w[0]) && FUNCTION_CHARS.has(w[1])) continue;
    out.add(w);
  }
  return out;
}

/**
 * 找未知词。
 * @param {Array<{text?:string, plain?:string}>} messages 最近消息
 * @param {string} knownText 已有的 lessons 全文（出现过就算认识）
 * @param {{minMessages?:number, limit?:number}} opts
 * @returns {Array<{term:string, hits:number}>}
 */
export function findUnknown(messages, knownText, opts = {}) {
  const minMessages = Math.max(2, Number(opts.minMessages) || 2); // [GLOSS-FIX] 词界+STOP+已知过滤后，2 次出现已够触发
  const limit = Math.max(1, Number(opts.limit) || 8);
  const known = String(knownText ?? '').toLowerCase();
  const counter = new Map(); // term -> 出现在多少条消息里

  for (const m of Array.isArray(messages) ? messages : []) {
    const text = String(m?.text ?? m?.plain ?? '');
    if (!text) continue;
    const seenThisMsg = new Set();
    for (const term of extractTerms(text)) {
      if (seenThisMsg.has(term)) continue;
      seenThisMsg.add(term);
      counter.set(term, (counter.get(term) || 0) + 1);
    }
  }

  const cands = [];
  for (const [term, hits] of counter) {
    if (hits < minMessages) continue;
    if (known.includes(term)) continue;            // 已经认识
    if (term.length < 2) continue;
    cands.push({ term, hits });
  }
  // [GLOSS-FIX] 拉丁串优先（梗/缩写大多在这），其余按出现次数；上限 6 个别刷屏
  const isLatin = (t) => /[a-z]{2}/.test(t);
  cands.sort((a, b) => (Number(isLatin(b.term)) - Number(isLatin(a.term))) || (b.hits - a.hits) || (b.term.length - a.term.length));
  return cands.slice(0, Math.min(limit, 6));
}

/** 拼成给模型看的一句（没有就返回空串） */
export function renderUnknown(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `你这几天见过几个词，可能还不懂什么意思：${list.map((x) => x.term).join('、')}。\n`
    + '有空可以搜一下它们啥意思、什么场合用（搜到了就 lesson_write 记一条，别照抄定义）。';
}
