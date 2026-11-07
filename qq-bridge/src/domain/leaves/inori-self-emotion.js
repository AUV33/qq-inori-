// inori-self-emotion.js · 她自己的情绪 + 共情立场（纯函数，零 IO）
//
// 和 inori-affect 的分工：
//   inori-affect / PragmaticFrame = 对方可能是什么情绪（感知）
//   本模块                       = 这件事落到她身上，她是什么感觉；她要不要共情、怎么共情
//
// 纪律：
//   · 不把对方的情绪自动复制成她的情绪（不情绪传染）；
//   · 共情不是“必须安慰”，可以理解、可以关心、也可以先做自己的事；
//   · 低置信度写“不一定/也可能”，不贴病名。

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function textOf(frame) { return String(frame?.evidence?.[0] || frame?.text || '').slice(0, 80); }

export function appraiseSelfEmotion({ frame = {}, selfState = {}, relationship = {}, outcomes = [], now = Date.now() } = {}) {
  const act = String(frame.speechAct || 'statement');
  const stance = String(frame.stance || 'serious');
  const other = String(frame.emotion?.label || 'unknown');
  const warmth = clamp01(selfState.warmth ?? 0.5);
  const energy = clamp01(selfState.energy ?? 0.6);
  const closeness = clamp01(relationship?.closeness ?? 0.5);
  const evidence = [textOf(frame)].filter(Boolean);

  let label = 'neutral';
  let valence = 0;
  let arousal = 0.3;
  let reason = '没有明显指向她的事';
  if (act === 'compliment' || act === 'warm') {
    label = 'warm'; valence = 0.6; arousal = 0.35; reason = '被夸/被温柔对待';
  } else if (act === 'joke') {
    label = 'amused'; valence = 0.5; arousal = 0.4; reason = '对方在开玩笑';
  } else if (act === 'tease') {
    label = stance === 'playful' ? 'amused' : 'stung';
    valence = stance === 'playful' ? 0.2 : -0.35; arousal = 0.45;
    reason = stance === 'playful' ? '像在逗她' : '像在刺她';
  } else if (act === 'test' || act === 'refusal') {
    label = 'guarded'; valence = -0.2; arousal = 0.5; reason = '对方在试探/拒绝，她先收紧';
  } else if (act === 'vent') {
    label = closeness >= 0.55 ? 'concerned' : 'uncomfortable';
    valence = closeness >= 0.55 ? -0.15 : -0.3; arousal = 0.45;
    reason = closeness >= 0.55 ? '在意的人难受，她会挂心' : '对方在倾倒情绪，她不一定接得住';
  } else if (act === 'request') {
    label = energy < 0.4 ? 'tired' : 'focused';
    valence = 0; arousal = energy < 0.4 ? 0.2 : 0.5; reason = '有事要做';
  } else if (other === 'happy') {
    label = 'warm'; valence = 0.35; arousal = 0.35; reason = '对方情绪好，她也被带暖一点';
  }
  if (energy < 0.3 && label !== 'concerned') { label = 'tired'; valence = Math.min(valence, 0); arousal = Math.min(arousal, 0.3); reason = '她自己的精力很低'; }
  const confidence = Math.min(0.75, 0.4 + (evidence.length ? 0.1 : 0) + (act !== 'statement' ? 0.1 : 0) + closeness * 0.1);
  return {
    label, valence: Number(valence.toFixed(2)), arousal: Number(arousal.toFixed(2)),
    confidence: Number(confidence.toFixed(2)), reason, evidence,
    alternatives: ['也可能只是这一刻的感觉', '也可能她自己也说不清'],
    at: now,
  };
}

export function buildEmpathicStance({ frame = {}, selfEmotion = {}, relationship = {}, who = '对方' } = {}) {
  const other = String(frame.emotion?.label || 'unknown');
  const act = String(frame.speechAct || 'statement');
  const label = String(selfEmotion.label || 'neutral');
  const closeness = clamp01(relationship?.closeness ?? 0.5);
  const understanding = other === 'unknown' ? '还不确定他是什么感觉' : `他可能${other}`;
  let compassion = '先不急着做什么';
  if (['sad', 'anxious', 'tired', 'upset'].includes(other) && closeness >= 0.4) compassion = '有点心疼，想陪一下';
  else if (act === 'vent') compassion = '听见了，但不替他把情绪扛走';
  else if (act === 'test' || act === 'refusal') compassion = '先守住自己的边界，不急着证明什么';
  const boundary = (act === 'test' || act === 'refusal' || other === 'angry')
    ? '对方的情绪不等于她的错；可以澄清，也可以先退开。'
    : '共情不等于必须安慰；可以理解，也可以先做自己的事。';
  return {
    understanding,
    resonance: label === 'neutral' ? '她这边没有明显被带动' : `她这边是${label}`,
    compassion,
    boundary,
    options: ['问一句', '陪一下', '先做自己的事', '不接'],
  };
}

export function renderSelfEmotionBlock(selfEmotion, empathy) {
  if (!selfEmotion || !selfEmotion.label) return '';
  const e = selfEmotion;
  const conf = Number(e.confidence) || 0;
  const ev = e.evidence?.length ? `；证据：${e.evidence.join('、')}` : '';
  const lines = [`【你这边的情绪】${e.label}（置信 ${conf.toFixed(2)}${ev}；也可能只是这一刻）`];
  if (empathy) {
    lines.push(`【你感到的】${empathy.resonance}；${empathy.compassion}。`);
    lines.push(`【边界】${empathy.boundary}`);
  }
  return lines.join('\n');
}
