// inori-pragmatics.js · 语用层：这句话在干什么（纯函数，零 IO）
//
// 目的不是“读心”，而是把一句话整理成她可以判断的结构：
//   speechAct 陈述/提问/请求/吐槽/玩笑/试探/夸/拒绝/求助/搭话
//   target    对她说 / 说别人 / 对群里
//   stance    认真/玩笑/阴阳/温柔/不确定
//   demand    回/答/做/只听/不用回
//   emotion   带证据的假设，不是结论
//
// 纪律：低置信度写 unknown；evidence 只放原文片段；不贴病名、不诊断。

const RE = {
  question: /[?？]|吗[。.!！…～~]*$|呢[。.!！…～~]*$|怎么|为什么|为啥|是不是|什么|多少|哪[个里]|谁/,
  request: /帮我|能不能|可不可以|可以帮|麻烦|请你|给我|替我|去做|去看看|看一下|发我|告诉我/,
  vent: /烦死|好烦|累死|难受|崩溃|无语|服了|气死|受不了|委屈|想哭|不想动/,
  joke: /哈哈+|笑死|草|绷不住|乐死|233|狗头|🐶|😂|🤣|玩梗/,
  tease: /傻|菜|蠢|呆|笨|2b|小笨蛋|小菜鸡/,
  test: /你是不是|是不是我|你是不是觉得|是不是在敷衍|是不是不喜欢|你生气了吗|你是不是不想/,
  compliment: /厉害|好看|可爱|喜欢|谢谢|辛苦了|真棒/,
  refusal: /不要|不用|算了|不想|别了|没必要|懒得/,
  bid: /在吗|你看|跟你说|听我说|我问你|有空吗/,
  warm: /抱抱|晚安|早安|辛苦|谢谢|喜欢你|想你/,
  sad: /难过|想哭|失落|不开心|委屈|心里堵/,
  angry: /烦死|气死|滚|傻逼|无语|服了|受不了|凭什么/,
  anxious: /怎么办|焦虑|担心|害怕|睡不着|慌/,
  tired: /累|困|没力气|不想动|撑不住|熬夜/,
  happy: /开心|好耶|太好了|喜欢|哈哈|笑死/,
};

function hit(text, re) { return re.test(text); }

export function classifyPragmaticFrame(text, { recent = [], key = '' } = {}) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!raw) return { speechAct: 'unknown', target: 'unknown', stance: 'unknown', demand: 'unknown', emotion: { label: 'unknown', confidence: 0, evidence: [], alternatives: [] }, confidence: 0, evidence: [] };

  let speechAct = 'statement';
  if (hit(raw, RE.question)) speechAct = 'question';
  if (hit(raw, RE.request)) speechAct = 'request';
  if (hit(raw, RE.vent)) speechAct = 'vent';
  if (hit(raw, RE.joke)) speechAct = 'joke';
  if (hit(raw, RE.tease)) speechAct = 'tease';
  if (hit(raw, RE.test)) speechAct = 'test';
  if (hit(raw, RE.compliment)) speechAct = 'compliment';
  if (hit(raw, RE.refusal)) speechAct = 'refusal';
  if (hit(raw, RE.bid)) speechAct = 'bid';
  if (speechAct === 'statement' && hit(raw, RE.warm)) speechAct = 'warm';

  let target = 'group';
  if (/你|您|@|名字/.test(raw)) target = 'her';
  else if (/他|她|他们|她们|别人|那个人/.test(raw)) target = 'other';

  let stance = 'serious';
  if (hit(raw, RE.joke) || hit(raw, RE.tease)) stance = 'playful';
  if (/呵呵|行吧|随便|真棒|你开心就好/.test(raw)) stance = 'sarcastic';
  if (hit(raw, RE.warm)) stance = 'tender';
  if (speechAct === 'unknown') stance = 'unknown';

  let demand = 'none';
  if (speechAct === 'request') demand = 'act';
  else if (speechAct === 'question' || speechAct === 'test') demand = 'reply';
  else if (speechAct === 'vent') demand = 'ack';
  else if (speechAct === 'bid') demand = 'reply';

  const emotion = inferEmotionHypothesis(raw, { speechAct, stance, recent });
  const confidence = Math.min(0.85, 0.35 + (speechAct !== 'statement' ? 0.15 : 0) + (target !== 'group' ? 0.1 : 0));
  return {
    speechAct, target, stance, demand, emotion, confidence,
    evidence: [raw.slice(0, 80)],
  };
}

export function inferEmotionHypothesis(text, { speechAct = '', stance = '', recent = [] } = {}) {
  const raw = String(text ?? '');
  const evidence = [];
  let label = 'unknown';
  let score = 0;
  const consider = (name, re, weight) => {
    if (hit(raw, re)) { label = name; score += weight; evidence.push((raw.match(re) || [])[0].slice(0, 20)); }
  };
  consider('sad', RE.sad, 2);
  consider('angry', RE.angry, 2);
  consider('anxious', RE.anxious, 2);
  consider('tired', RE.tired, 2);
  consider('happy', RE.happy, 1);
  if (label === 'unknown' && speechAct === 'vent') { label = 'upset'; score = 1; evidence.push('在吐槽/抱怨'); }
  if (label === 'unknown' && stance === 'playful') { label = 'playful'; score = 1; evidence.push('像在开玩笑'); }
  const confidence = Math.min(0.75, score * 0.22 + (recent.length ? 0.05 : 0));
  return {
    label,
    confidence: Number(confidence.toFixed(2)),
    evidence: [...new Set(evidence)].slice(0, 3),
    alternatives: label === 'unknown'
      ? ['也可能只是陈述事实', '也可能只是随口一说']
      : ['也可能只是开玩笑', '也可能不想被追问'],
  };
}

export function renderPragmaticBlock(frame, { includeEmotion = true } = {}) {
  if (!frame || frame.speechAct === 'unknown') return '';
  const targetMap = { her: '对你说', other: '在说别人', group: '对群里说', unknown: '对象不确定' };
  const demandMap = { reply: '像是在等你回', act: '像是在等你做', ack: '可能只想被听见', none: '不一定需要你接', unknown: '要不要接由你判断' };
  const lines = [
    `【这句像是在】${frame.speechAct || '陈述'}；${targetMap[frame.target] || '对象不确定'}；${frame.stance || '态度不确定'}；${demandMap[frame.demand] || '要不要接由你判断'}。`,
  ];
  const emo = frame.emotion || {};
  if (!includeEmotion) return lines.join('\n');
  if (emo.label && emo.label !== 'unknown') {
    const conf = Number(emo.confidence) || 0;
    const evidence = Array.isArray(emo.evidence) && emo.evidence.length ? `；证据：${emo.evidence.join('、')}` : '';
    const alt = Array.isArray(emo.alternatives) && emo.alternatives.length ? `；也可能：${emo.alternatives[0]}` : '';
    lines.push(`【情绪线索】${emo.label}（置信 ${conf.toFixed(2)}${evidence}${alt}）。这是假设，不是诊断。`);
  } else if (frame.speechAct !== 'statement') {
    lines.push('【情绪线索】不确定；先别替对方下结论，必要时问一句。');
  }
  return lines.join('\n');
}
