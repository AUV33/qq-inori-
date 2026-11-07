// move-selector.mjs · 宪章 §5.16：感知之后先选"动作"，再谈"怎么说"
//
// 干什么：把 perception（对谁说的/在做什么）与本我状态（精力/压力/社交饥饿）、关系（亲疏/禁忌）
//   合成一个 move：silence / minimal / reply / participate / question / tease / comfort / deflect；
//   同时给出 explicitness（0 藏起来 … 1 摊开说）和 confidence。
// 为什么：现有链路只有"回不回"和"怎么发"，没有"这一下该做什么动作"。动作层缺失时，
//   所有场合都退化成同一种"接话"，该沉默时接、该安慰时讲道理、该退开时追问。
// 输入输出：纯函数、无 IO、确定性；缺字段按默认。
// 失败模式：信息不足时保守（silence/minimal），不假装确定。
// 不做什么：不生成文本、不决定发送、不改唤醒；只给动作与理由。

// [TOM] 先读意图，再选动作（纯函数）。
import { inferIntent } from './theory-of-mind.mjs';

export const MOVE_SELECTOR_VERSION = 1;

const MOVES = Object.freeze(['silence', 'minimal', 'reply', 'participate', 'question', 'tease', 'comfort', 'deflect']);

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
const clamp01 = (v) => Math.max(0, Math.min(1, num(v)));

function tabooHit(text, bond) {
  const t = String(text ?? '');
  if (!t) return '';
  for (const item of Array.isArray(bond?.taboo) ? bond.taboo : []) {
    const topic = String(item?.topic ?? '').trim();
    if (topic && t.includes(topic)) return topic;
  }
  return '';
}

/**
 * @param {{perception?:object|null, self?:object|null, bond?:object|null, scene?:'private'|'group',
 *          text?:string, isOwner?:boolean}} input
 */
export function chooseMove(input = {}) {
  const p = input.perception && typeof input.perception === 'object' ? input.perception : null;
  const self = input.self && typeof input.self === 'object' ? input.self : {};
  const bond = input.bond && typeof input.bond === 'object' ? input.bond : {};
  const scene = input.scene === 'group' ? 'group' : 'private';
  const reasons = [];
  const finish = (move, explicitness, confidence, note) => {
    if (note) reasons.push(note);
    return { v: MOVE_SELECTOR_VERSION, move, explicitness: Math.round(clamp01(explicitness) * 100) / 100, confidence: Math.round(clamp01(confidence) * 100) / 100, reasons };
  };

  // 1) 生理底线优先：没精力就不硬撑。
  if (num(self.energy, 0.6) <= 0.15) return finish('silence', 0, 0.8, '精力过低');
  if (num(self.stress, 0.1) >= 0.85) return finish('minimal', 0.15, 0.75, '压力过高');

  if (!p) return finish('reply', 0.4, 0.3, '没有感知信息，保守接话');

  const addressee = String(p.addressee || 'unknown');
  const act = String(p.speechAct || 'statement');
  // [BUDGET] 每小时上限是硬配额；最小间隔可以给“直接问她”让路。
  if (input.budget && input.budget.allowed === false) {
    const direct = addressee === 'her' && (act === 'question' || act === 'request');
    const reason = input.budget.reason || 'not-allowed';
    if (!(reason === 'min-gap' && direct)) {
      return finish('silence', 0, 0.9, `互动预算：${reason}`);
    }
  }
  const affinity = num(bond.affinity, 0.5);
  const tom = input.tom && typeof input.tom === 'object'
    ? input.tom
    : inferIntent({ perception: p, bond, text: input.text, scene });
  const trust = num(bond.trust, 0.5);
  const hunger = num(self.socialHunger, 0.4);
  const taboo = tabooHit(input.text, bond);

  if (taboo) {
    return finish(input.isOwner ? 'deflect' : 'deflect', 0.1, 0.9, `碰到禁忌「${taboo}」`);
  }
  // [GROUP-HEALTH] 群里气氛紧且没点她：先不添话（点她仍要回）。
  if (scene === 'group' && input.groupHealth && input.groupHealth.label === 'tense' && addressee !== 'her') {
    return finish('silence', 0, 0.7, '群里气氛紧，没点她');
  }
  if (addressee === 'other') {
    return finish('silence', 0, 0.75, '在跟别人说话');
  }
  if (act === 'withdraw') {
    return finish('silence', 0, 0.8, '对方在退开，不追');
  }
  if (addressee === 'unknown') {
    return finish('minimal', 0.15, 0.3, '读不出指向');
  }

  // [TOM] 明确在试探边界、且关系不够近：不把试探当玩笑接。
  if (tom.intent === 'test_boundary' && affinity < 0.6) {
    return finish('minimal', 0.1, 0.55, '像在试探边界，关系不够近');
  }
  if (act === 'complaint') {
    if ((tom.intent === 'seek_comfort' && affinity >= 0.4) || affinity >= 0.6 || trust >= 0.6) return finish('comfort', 0.35, 0.7, '读作求安慰，先接情绪');
    return finish('minimal', 0.1, 0.55, '关系一般，不擅自安慰');
  }
  if (act === 'tease') {
    if (affinity >= 0.5) return finish('tease', 0.45, 0.7, '关系够近，可以接梗');
    return finish('minimal', 0.15, 0.5, '关系不够近，不接梗');
  }
  if (act === 'question') {
    if (addressee === 'her') return finish('reply', 0.65, 0.8, '在问她');
    if (scene === 'group') {
      return hunger >= 0.5
        ? finish('participate', 0.3, 0.45, '群里泛问，她想参与')
        : finish('silence', 0, 0.55, '群里泛问，没点她，不抢话');
    }
    return finish('reply', 0.55, 0.6, '私聊提问');
  }
  if (scene === 'private' && (input.isOwner || addressee === 'her')) {
    return finish('reply', 0.5, 0.7, '私聊对她说');
  }
  if (scene === 'group') {
    if (addressee === 'her') return finish('reply', 0.5, 0.75, '群里点她说');
    if (hunger >= 0.65) return finish('participate', 0.25, 0.4, '社交饥饿高，想插一句');
    return finish('silence', 0, 0.5, '群里没点她，先听');
  }
  return finish('reply', 0.4, 0.4, '默认接话');
}

/** 渲染动作理由（日志/影子用）。 */
export function describeMove(move) {
  if (!move) return '';
  const names = { silence: '沉默', minimal: '极简回应', reply: '回应', participate: '参与', question: '追问', tease: '接梗', comfort: '安慰', deflect: '避开' };
  return `动作=${names[move.move] || move.move}（摊开度 ${Math.round(Number(move.explicitness || 0) * 100)}%，置信 ${Math.round(Number(move.confidence || 0) * 100)}%）`;
}

export { MOVES };
