// perception.mjs · 宪章 §5.16：先感知，再反应（纯函数）
//
// 干什么：一条入站消息先解析"这是对谁说的、在做什么动作"，并保留**多读法**而不是急着下结论：
//   · addressee：her / owner / other / broadcast / unknown；
//   · speechAct：question / request / tease / complaint / withdraw / brag / emoji / statement；
//   · candidates：至少两种读法（含置信度），供后续动作选择参考。
// 为什么：现有链路直接进"要不要回"，没有显式的指代/动作层；群里一句话可能是在问别人、
//   也可能是自言自语。"先感知再反应"是交互层的地基，也是误读可回退（§5.17）的前提。
// 输入输出：纯函数；无 IO、无随机；同输入同输出。
// 失败模式：字段缺失按 unknown/broadcast 处理；不抛错。
// 不做什么：不决定回不回、不生成文本、不做人格判断；只是"读到了什么"。

export const PERCEPTION_VERSION = 1;

const QUESTION_RE = /[?？]|(吗|呢|什么|怎么|为什么|哪|谁|多少|是不是|能不能|会不会|要不要|好不好)(?:[。！!~～\s]|$)/;
const REQUEST_RE = /帮我|给我|麻烦|请你|可不可以|能不能|帮我个忙|替我看|看一下/;
const TEASE_RE = /哈哈|笑死|乐死|就这|菜|笨|傻了|无语|绷不住|草/;
const COMPLAINT_RE = /烦|累|难受|不开心|生气|委屈|崩了|自闭|心累/;
const WITHDRAW_RE = /算了|不想说|没事|随便|不用了|懒得|没兴趣|别问了/;
const BRAG_RE = /我(?:今天|刚才|刚|又|已经)?[^。！？]{0,12}(厉害|赢了|第一|考了|做到了|成功了)/;
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s~～。.!！?？]+$/u;

function hasCjkOrWord(text) {
  return /[\p{Script=Han}A-Za-z0-9]/u.test(String(text ?? ''));
}

/** 发言动作识别（确定性、粗粒度）。 */
export function speechActOf(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'silence';
  if (!hasCjkOrWord(t) && EMOJI_ONLY_RE.test(t)) return 'emoji';
  if (QUESTION_RE.test(t)) return 'question';
  if (REQUEST_RE.test(t)) return 'request';
  if (WITHDRAW_RE.test(t)) return 'withdraw';
  if (COMPLAINT_RE.test(t)) return 'complaint';
  if (TEASE_RE.test(t)) return 'tease';
  if (BRAG_RE.test(t)) return 'brag';
  return 'statement';
}

/**
 * @param {{text:string, kind?:'private'|'group', senderId?:string, senderName?:string,
 *          selfId?:string, ownerId?:string, mentionedIds?:string[], quoteTargetIsSelf?:boolean}} input
 * @returns {{v:number, addressee:string, speechAct:string, ambiguity:number, candidates:Array}}
 */
export function perceiveInbound(input = {}) {
  const text = String(input.text ?? '').trim();
  const kind = input.kind === 'private' ? 'private' : 'group';
  const selfId = String(input.selfId ?? '').trim();
  const ownerId = String(input.ownerId ?? '').trim();
  const senderId = String(input.senderId ?? '').trim();
  const mentions = [...new Set((Array.isArray(input.mentionedIds) ? input.mentionedIds : []).map((x) => String(x).trim()).filter(Boolean))];
  const mentionsHer = !!selfId && mentions.includes(selfId);
  const mentionsOther = mentions.some((id) => id !== selfId && id !== 'all');
  const mentionsAll = mentions.includes('all');
  const isOwner = !!ownerId && senderId === ownerId;
  const quoteSelf = input.quoteTargetIsSelf === true;
  const act = speechActOf(text);

  let addressee = 'unknown';
  const candidates = [];
  const add = (reading, confidence, note) => candidates.push({ reading, confidence: Math.max(0, Math.min(1, confidence)), note });

  if (kind === 'private') {
    addressee = 'her';
    add('对她说的私聊', 0.95, '私聊默认对她说');
  } else if (mentionsHer || quoteSelf) {
    addressee = 'her';
    add('点名叫她/引用她', 0.95, mentionsHer ? '@了她' : '引用了她的话');
    if (act === 'question') add('也可能是问群里其他人', 0.2, '群聊问题不总是指向她');
  } else if (mentionsOther) {
    addressee = 'other';
    add('在叫别人', 0.7, '@了其他人');
    add('顺带说给群里听', 0.25, '被 @ 的人之外也可能被听见');
  } else if (mentionsAll) {
    addressee = 'broadcast';
    add('对所有人说', 0.7, '@全体');
  } else if (isOwner) {
    addressee = 'broadcast';
    add('主人在群里说话（没点名）', 0.55, '不一定是在叫她');
    add('也可能是在对她说', 0.3, '主人说话她可以接');
  } else {
    addressee = 'broadcast';
    add('群里泛说', 0.55, '没有点名');
    if (act === 'question') add('问题可能是在问她', 0.3, '群里没人点名的问题也可能期待她接');
    if (act === 'withdraw' || act === 'complaint') add('可能只是自言自语', 0.25, '情绪话不一定需要回应');
  }
  if (!candidates.length) add('读不出指向', 0.5, '信息不足');

  const top = candidates.slice().sort((a, b) => b.confidence - a.confidence)[0];
  const second = candidates.slice().sort((a, b) => b.confidence - a.confidence)[1];
  const ambiguity = second ? Math.max(0, 1 - Math.abs(top.confidence - second.confidence)) * 0.5 : 0;
  return {
    v: PERCEPTION_VERSION,
    addressee,
    speechAct: act,
    ambiguity: Math.round(ambiguity * 1000) / 1000,
    candidates,
  };
}

/** 渲染一行可注入的"感知"（给 prompt 用；目前只作为影子/上下文，不命令她）。 */
export function renderPerceptionLine(perception) {
  if (!perception) return '';
  const map = { her: '像是在对她说', owner: '主人在说', other: '像是在叫别人', broadcast: '像是在群里泛说', unknown: '读不出指向' };
  const actMap = { question: '提问', request: '请求', tease: '玩笑', complaint: '抱怨', withdraw: '退开', brag: '炫耀', emoji: '表情', statement: '陈述', silence: '沉默' };
  return `感知：${map[perception.addressee] || perception.addressee}；动作：${actMap[perception.speechAct] || perception.speechAct}（不确定 ${Math.round(Number(perception.ambiguity || 0) * 100)}%）`;
}
