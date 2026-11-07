// theory-of-mind.mjs · 宪章 §5.13：先猜“他此刻想干什么”，再决定接不接
//
// 干什么：从感知（指代/动作）+ 关系（亲疏/信任）+ 场合，推断对方可能的意图（多候选 + 置信度）：
//   seek_comfort / share / ask_help / test_boundary / play / withdraw / inform / seek_attention。
// 为什么：感知层回答“他在做什么动作”，不等于“他想要什么”。把两者混在一起，会把玩笑当攻击、
//   把求助当闲聊。ToM 是动作选择之前的最后一层“读心”，且必须保留不确定性。
// 输入输出：纯函数；不调模型、不读盘；缺字段按中性。
// 失败模式：无感知返回 unknown/low confidence；不抛错。
// 不做什么：不做人格判断、不替她决定回不回；只是意图候选。

export const TOM_VERSION = 1;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const clean = (v) => String(v ?? '').trim();

/**
 * @param {{perception?:object|null, bond?:object|null, text?:string, scene?:string}} input
 */
export function inferIntent(input = {}) {
  const p = input.perception && typeof input.perception === 'object' ? input.perception : null;
  const bond = input.bond && typeof input.bond === 'object' ? input.bond : {};
  const affinity = clamp01(bond.affinity ?? 0.5);
  const addressee = clean(p?.addressee) || 'unknown';
  const act = clean(p?.speechAct) || 'statement';
  const candidates = [];
  const add = (intent, confidence, note) => candidates.push({ intent, confidence: clamp01(confidence), note });
  if (!p) {
    return { v: TOM_VERSION, intent: 'unknown', confidence: 0.2, uncertainty: 0.8, candidates: [{ intent: 'unknown', confidence: 0.2, note: '没有感知信息' }] };
  }

  if (addressee === 'other') add('inform', 0.5, '在跟别人说');
  if (act === 'withdraw') add('withdraw', 0.85, '在退开');
  if (act === 'complaint') {
    add('seek_comfort', affinity >= 0.45 ? 0.7 : 0.4, affinity >= 0.45 ? '关系够近，可能在求安慰' : '关系一般，可能只是说出来');
    add('share', 0.35, '也可能只是分享情绪');
  }
  if (act === 'question') {
    add('ask_help', addressee === 'her' ? 0.75 : 0.5, addressee === 'her' ? '在问她' : '可能在问群里');
    if (addressee === 'broadcast') add('seek_attention', 0.5, '泛问也可能是在求回应');
  }
  if (act === 'request') add('ask_help', 0.8, '明确请求');
  if (act === 'tease') {
    add(affinity >= 0.55 ? 'play' : 'test_boundary', affinity >= 0.55 ? 0.65 : 0.5, affinity >= 0.55 ? '关系近，像玩闹' : '关系一般，可能在试探边界');
  }
  if (act === 'emoji') add('play', 0.5, '表情多半是玩');
  if (act === 'brag') add('share', 0.6, '在分享得意的事');
  if (act === 'statement') add('inform', 0.5, '在说一件事');
  if (act === 'question' && addressee === 'her') add('test_boundary', 0.25, '也可能在探她');
  if (!candidates.length) add('unknown', 0.25, '读不出意图');

  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0];
  const second = candidates[1];
  const margin = second ? Math.max(0, top.confidence - second.confidence) : top.confidence;
  return {
    v: TOM_VERSION,
    intent: top.intent,
    confidence: Math.round(top.confidence * 1000) / 1000,
    uncertainty: Math.round((1 - clamp01(margin)) * 1000) / 1000,
    candidates: candidates.slice(0, 4),
  };
}

/** 一行可注入的“读心”（不是命令）。 */
export function renderIntentLine(tom) {
  if (!tom?.intent || tom.intent === 'unknown') return '';
  const map = { seek_comfort: '可能想被安慰', share: '可能只是想说说', ask_help: '可能在求助', test_boundary: '可能在试探', play: '像在玩', withdraw: '在退开', inform: '在说一件事', seek_attention: '可能在求回应' };
  return `他此刻${map[tom.intent] || tom.intent}（置信 ${Math.round(Number(tom.confidence || 0) * 100)}%）`;
}
