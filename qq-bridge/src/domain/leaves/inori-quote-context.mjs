// inori-quote-context.mjs · 「有人引用了你那条」→ 把她当时在接的上下文递回去
//
// 背景（2026-10-30）：群里有人引用她的「那你就别叫。」问「你这一句回的是哪」，
// 她答「不记得了」。她的唤醒快照里只有引用句柄（[引用 她：那你就别叫。]），
// 没有「她说那句时群里在聊什么」，而那条信息只活在上一个回合的上下文里。
//
// 两个数据源（按优先级）：
//   1) utterance 账本：她发过的每条话 + 当时的前文，落在记忆库里（kind=utterance）。
//      不依赖 recentMessages 的 100 条窗口，半小时后、第二天引用都能答。
//   2) recentMessages：账本没命中时退回会话窗口（老行为）。
//
// 纪律：
//   · 纯函数、零 IO；只递事实，不替她编"你当时是在回 X"——用「发那条之前群里最近在说」的口径。
//   · 只在有引用、且引用的是她、且能找到她那条原话（或账本记录）时才出块；找不到就什么都不说。
//   · 引用本身超过 maxAgeMs 就不再占位（否则同一句被引用后每次唤醒重贴）；账本可以更旧（默认 3 天）。

/** 从渲染后的消息正文里取出被引用的原文。
 *  注意：被引用的内容本身可能带方括号（[图片]/[表情]/[CQ:…]），不能用懒惰正则第一个 ] 截断。
 *  例：[引用 她：[图片]]@她 还是这个是你画的 → 原文 = "[图片]" */
export function quotedTextOf(text) {
  const s = String(text ?? '').trim();
  const m = /^\[引用 [^：:]+[：:]/.exec(s);
  if (!m) return '';
  const rest = s.slice(m[0].length);
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      if (depth === 0) return rest.slice(0, i).replace(/\s+/g, ' ').trim();
      depth -= 1;
    }
  }
  return '';
}

function bodyOf(m) {
  return String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 二元组覆盖率（quote 的 grams 有多少出现在 candidate 里）。 */
function coverage(quote, candidate) {
  const q = norm(quote);
  const c = norm(candidate);
  if (q.length < 2 || c.length < 2) return 0;
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2));
  let hit = 0;
  for (const g of grams) if (c.includes(g)) hit += 1;
  return hit / Math.max(1, grams.size);
}

function renderBlock(quoteText, prevLines) {
  return [
    `【有人引用了你那条「${quoteText.slice(0, 40)}」】`,
    '发那条之前，群里最近在说：',
    ...prevLines,
    '（这是当时的前文；记不清就直接问对方指的是哪条，别硬编。）',
  ].join('\n');
}

/**
 * 找最后一条「引用了她」的消息，回推她那条原话发出前的几条群消息。
 * @param {Array<object>} messages 会话的 recentMessages（按时间正序）
 * @param {{maxPrev?: number, maxAgeMs?: number, now?: number, utterances?: Array<object>, maxUtteranceAgeMs?: number}} opts
 * @returns {string} 空串 = 没有可递的（不制造暗示）
 */
export function buildQuoteContext(messages, {
  maxPrev = 3,
  maxAgeMs = 10 * 60 * 1000,
  maxUtteranceAgeMs = 3 * 86400000,
  now = Date.now(),
  utterances = [],
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let quoteText = '';
  let quoteAt = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const quoted = list[i];
    if (!quoted || quoted.isSelf || !quoted.quoteTargetIsSelf) continue;
    if (Number.isFinite(Number(quoted.time)) && now - Number(quoted.time) > maxAgeMs) continue;
    const text = quotedTextOf(bodyOf(quoted));
    if (!text) continue;
    quoteText = text;
    quoteAt = Number(quoted.time) || 0;
    break;
  }
  if (!quoteText) return '';

  // 1) utterance 账本：她说过的话（可跨窗口）
  if (Array.isArray(utterances) && utterances.length) {
    let hit = null;
    for (let i = utterances.length - 1; i >= 0; i -= 1) {
      const u = utterances[i];
      if (!u || !u.text) continue;
      const t = Number(u.time) || Date.parse(String(u.at ?? '')) || 0;
      if (quoteAt && t && quoteAt - t > maxUtteranceAgeMs) continue; // 只找引用之前发的话
      const same = norm(u.text).includes(norm(quoteText).slice(0, 10)) || coverage(quoteText, u.text) >= 0.8;
      if (!same) continue;
      hit = u;
      break;
    }
    if (hit) {
      const ctx = (Array.isArray(hit.ctx) ? hit.ctx : [])
        .filter((c) => c && c.text)
        .slice(-maxPrev);
      if (ctx.length) {
        return renderBlock(quoteText, ctx.map((c) => `seq${c.seq ?? '?'} ${c.sender ?? '?'}：${String(c.text).slice(0, 60)}`));
      }
    }
  }

  // 2) 退回会话窗口
  let at = -1;
  const needle = quoteText.slice(0, 16);
  for (let k = list.length - 1; k >= 0; k -= 1) {
    const s = list[k];
    if (!s || !s.isSelf) continue;
    if (bodyOf(s).includes(needle)) { at = k; break; }
  }
  if (at < 0) return '';
  const prev = list.slice(0, at)
    .filter((x) => x && !x.isSelf)
    .slice(-maxPrev);
  if (!prev.length) return '';
  return renderBlock(quoteText, prev.map((x) => `seq${x.seq ?? '?'} ${x.sender ?? '?'}：${bodyOf(x).slice(0, 60)}`));
}
