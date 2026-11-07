// inori-mood-topic.js · 话题类型 × 情绪状态 → 回复倾向
//
// 设计原则（沿用 mizuse 的纪律）：
//   1) 纯函数、零依赖、可复现：同样的 (state, topic) 一定得到同样的倾向值
//   2) 只给「倾向」，不给「台词」：最终怎么说是她自己的事，框架不替她写
//   3) 有界：所有概率/上限都夹在固定区间，不出现自激
//   4) 可断言：每条规则都能用数值验证（单调、边界、可复现）
//
// 话题分类不依赖分词器（环境无 jieba），只用关键词表 + 命中数。

export const TOPICS = ['emotion', 'body', 'work', 'joke', 'daily', 'intimate'];

// 关键词表：每类给一组词，按**加权命中数**取最高的类；全不命中 → daily
// 权重理由：日常词（今天/天气）太泛，命中两个也不等于话题重心在闲聊；
// 而情绪/身体一旦出现，几乎一定是他真正想说的那件事。
const LEXICON = {
  emotion: ['想你', '难过', '开心', '烦', '累', '哭', '生气', '怕', '孤独', '委屈', '难受', '心情', '不开心', '想哭', '焦虑'],
  body: ['病', '疼', '医院', '发烧', '胃', '头疼', '失眠', '睡觉', '体检', '感冒', '吃药', '复查', '咳嗽'],
  work: ['工作', '加班', '上班', '老板', '项目', '同事', '辞职', '工资', '面试', '开会', 'deadline', '汇报'],
  joke: ['哈哈', '笑死', 'hhhh', '梗', '开玩笑', '逗你', '傻', '草', '乐'],
  intimate: ['喜欢你', '亲', '抱', '晚安', '早安', '想见你', '在吗', '爱你', '宝贝'],
  daily: ['吃了', '天气', '几点', '干嘛', '忙吗', '睡了没', '今天'],
};

// 权重：情绪最重，日常最轻
const WEIGHT = { emotion: 1.5, body: 1.3, intimate: 1.2, work: 1.0, joke: 0.9, daily: 0.6 };

/** 话题分类：返回 { type, hits, scores } */
export function classifyTopic(text) {
  const s = String(text ?? '');
  const scores = {};
  const weighted = {};
  for (const [type, words] of Object.entries(LEXICON)) {
    let hits = 0;
    for (const w of words) if (s.includes(w)) hits += 1;
    scores[type] = hits;
    weighted[type] = hits * (WEIGHT[type] ?? 1);
  }
  // 同分时的优先级：情绪 > 身体 > 亲密 > 工作 > 玩笑 > 日常
  const order = ['emotion', 'body', 'intimate', 'work', 'joke', 'daily'];
  let best = 'daily';
  let bestScore = 0;
  for (const t of order) {
    if (weighted[t] > bestScore) { best = t; bestScore = weighted[t]; }
  }
  return { type: best, hits: scores[best], scores, weighted };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * 回复倾向。返回：
 *   replyProb  0..1   她想回这条的可能性（由上层掷随机决定，模块本身不掷）
 *   maxChars   建议单条上限（-1 表示不限，可按心情写长）
 *   tone       'short' | 'normal' | 'earnest' | 'lazy'
 *   reason     给日志看的判据
 */
export function decide(state, topicInfo, valence = null) {
  const warmth = clamp(Number(state?.warmth ?? 0.5), 0, 1);
  const energy = clamp(Number(state?.energy ?? 0.6), 0, 1);
  const type = topicInfo?.type ?? 'daily';
  const neg = clamp(Number(valence?.negScore ?? 0), 0, 1);
  const reasons = [];

  // 基础：她本来就不太可能不理人
  let replyProb = 0.95;
  let maxChars = 60;
  let tone = 'normal';

  // 精力低 → 更可能已读不回、回得更短
  if (energy < 0.35) {
    replyProb -= 0.35;
    maxChars = Math.min(maxChars, 20);
    tone = 'lazy';
    reasons.push(`精力低(${energy.toFixed(2)})→少回`);
  } else if (energy < 0.5) {
    replyProb -= 0.12;
    tone = 'lazy';
    reasons.push(`精力偏低(${energy.toFixed(2)})`);
  }

  // 温度低 + 话题平常 → 更可能懒得应
  if (warmth < 0.35 && (type === 'daily' || type === 'joke')) {
    replyProb -= 0.2;
    reasons.push(`温度低(${warmth.toFixed(2)})且话题平常→懒得应`);
  }

  // 但情绪向/亲密向不能装死：即使状态差，也把概率托底
  if (type === 'emotion' || type === 'intimate') {
    replyProb = Math.max(replyProb, warmth > 0.55 ? 0.97 : 0.85);
    maxChars = warmth > 0.55 ? 400 : 120;
    tone = warmth > 0.55 ? 'earnest' : 'normal';
    reasons.push(`话题=${type}→接住`);
  } else if (type === 'body' || type === 'work') {
    replyProb = Math.max(replyProb, 0.8);
    maxChars = Math.max(maxChars, 80);
    reasons.push(`话题=${type}→认真`);
  }

  // 温度高 → 愿意多写一点
  if (warmth > 0.7) {
    maxChars = Math.max(maxChars, 120);
    if (tone === 'normal') tone = 'earnest';
    reasons.push(`温度高(${warmth.toFixed(2)})→愿意多说`);
  }
  if (warmth < 0.25) {
    maxChars = Math.min(maxChars, 15);
    tone = 'lazy';
    reasons.push(`温度很低(${warmth.toFixed(2)})→只说几个字`);
  }

  // 他难受的时候，不能装死 —— 这条优先于话题分类，也优先于她自己的状态。
  // 负向强度来自 NRC-VAD 负向词表（见 inori-valence.js），只认高强度词，
  // 所以「难过/心烦」这类轻词仍由上面的关键词分类兜。
  if (neg >= 0.5) {
    replyProb = Math.max(replyProb, 0.95);
    maxChars = Math.max(maxChars, 200);
    tone = 'earnest';
    reasons.push(`负向强度 ${neg.toFixed(2)}→必须在`);
  } else if (neg >= 0.3) {
    replyProb = Math.max(replyProb, 0.85);
    maxChars = Math.max(maxChars, 120);
    reasons.push(`负向强度 ${neg.toFixed(2)}→接住`);
  }

  return {
    replyProb: clamp(replyProb, 0.05, 0.99),
    maxChars: Math.max(5, maxChars),
    tone,
    topic: type,
    negativity: neg,
    reason: reasons.join('；') || '常态',
  };
}

/** 拼成给模型看的一小句（不是命令，是状态描述） */
export function moodLine(state, decision) {
  if (state?.enabled === false) return '';
  const w = Number(state?.warmth ?? 0.5);
  const e = Number(state?.energy ?? 0.6);
  const wTxt = w < 0.35 ? '有点冷' : w > 0.65 ? '暖和' : '一般';
  const eTxt = e < 0.35 ? '很累' : e < 0.5 ? '有点累' : e > 0.65 ? '有精神' : '还撑得住';
  const toneTxt = { lazy: '不太想动，回得会很短', short: '想简短说', normal: '正常聊', earnest: '想认真说几句' }[decision?.tone] ?? '正常聊';
  const topicTxt = { emotion: '在说心情', body: '在说身体', work: '在说工作', joke: '在开玩笑', intimate: '在撒娇', daily: '闲聊' }[decision?.topic] ?? '闲聊';
  const neg = Number(decision?.negativity ?? 0);
  const heavy = neg >= 0.5 ? '他这话不轻，别用轻飘飘的语气回。' : neg >= 0.3 ? '他情绪有点低。' : '';
  return `现在的你：心情${wTxt}（${w.toFixed(2)}），身体${eTxt}（${e.toFixed(2)}）。对方${topicTxt}，你${toneTxt}。${heavy}不想回也可以不回，不用解释。`;
}
