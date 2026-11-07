// inori-directed.js · "这句话是不是冲我来的" 本地判定（纯函数，零 IO）
//
// 用在两处：`question` 唤醒触发、活跃期"必须回"批量判定、以及未读里"有几条在问我"的计数。
// 为什么本地规则：每条消息都要跑，用模型等于每条都花钱还慢；这本质是字符串问题。
//
// 2026-10-25 夜用群里 413 条真实消息回归出的三处误判，已修：
//   1. 催促正则里的裸「说话」——这个群聊的话题就是"她会不会说话"，于是
//      「刚睡醒迷迷沉沉的怎么可能说话能说成这样」「然后说话」全被判成催她。
//      6 次命中里 5 次是误判，只剩「人呢/在不在」这类真催促。
//   2. 「[引用 某人：正文]@目标 真话」这种转述格式，旧代码把**别人的正文**当成本条内容匹配——
//      引用里的「你设置的？」会让"你+问"误命中。现在先剥引用前缀再判。
//   3. 单字别名不进关键词表（见 inori-aboutself.js 同一注释）：常见词会大面积误触发。
//
// 纪律：这里只回答"字面上像不像在问她"，不判断她该不该回——那是她的事。

/** AI/机器人相关称呼，用于「提到 AI 且在问/比较」 */
export const AI_MENTION_RE = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/;
/** 比较/挑战类词 */
export const CHALLENGE_RE = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/;
/** 疑问标记 */
export const QUESTION_RE = /[?？吗呢吧]|怎么|为什么|哪|谁/;
/** 明显的催促（不含裸「说话」——见文件头） */
export const URGE_RE = /怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死/;

/**
 * 剥掉群聊转述前缀：「[引用 某人：正文]@目标 真正的话」→「真正的话」。
 * 引用里的正文是别人的话，不该按"这条在跟我说"来判（引用她本人由 quoteTargetIsSelf 单独负责）。
 */
export function stripQuote(text) {
  const s = String(text ?? '');
  const m = s.match(/^\[引用[\s\S]*?\](?=\s*@)/);
  return m ? s.slice(m[0].length).trim() : s;
}

/** 快捷：是否提到 AI 相关称呼 */


/**
 * 这句话是否"直接针对她"：提到 AI 且带疑问/比较，或对"你"开火，或追问催促。
 * @returns {boolean}
 */
export function isDirectedAtAi(text) {
  const lower = stripQuote(text).toLowerCase();
  if (!lower.trim()) return false;
  if (AI_MENTION_RE.test(lower) && (QUESTION_RE.test(lower) || CHALLENGE_RE.test(lower))) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗"
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：她没回时的真人式催促（不再含裸「说话」）
  if (URGE_RE.test(lower)) return true;
  return false;
}

/** 判定带原因版本，方便日志/调参看清楚是哪条规则命中 */

export function mentionsAi(text) {
  return AI_MENTION_RE.test(String(text ?? '').toLowerCase());
}

export function directedWhy(text) {
  const lower = stripQuote(text).toLowerCase();
  if (!lower.trim()) return null;
  if (AI_MENTION_RE.test(lower) && (QUESTION_RE.test(lower) || CHALLENGE_RE.test(lower))) return 'ai+问';
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return '你+问';
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return '你开头';
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return '你是';
  if (URGE_RE.test(lower)) return '催促';
  return null;
}
