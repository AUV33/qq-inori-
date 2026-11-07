// inori-reasoning.js · 思考链的三段纯逻辑（零 IO，便于单测）
//
// 背景（2026-10-29）：思考在 DSH 会话日志里是完整的，但桥接以前从不读 reasoning。
// 这里只放"从事件里取思考 / 挑一句当摘要 / 判断要不要留全文或经验候选"这些纯函数；
// 落盘与注入在 app.mjs（flushReasoning）。

/** 从一条 assistant/message 事件里取出 reasoning 文本（只认 reasoning 块） */
export function reasoningTextOf(event) {
  try {
    const blocks = event?.data?.message?.content ?? [];
    const parts = [];
    for (const b of blocks) if (b && b.type === 'reasoning' && b.text) parts.push(String(b.text));
    return parts.join('\n').trim();
  } catch { return ''; }
}

/**
 * 从整段思考里挑"最像结论的一句"。
 * 不简单取最后一句：任务回合最后一句常是 "Close." / "Done." 这种收尾词。
 * 打分：中文权重高、含判断词加分、长度加分（封顶）。
 */
export function reasoningTailText(joined, { minLen = 10, maxLen = 140 } = {}) {
  const text = String(joined ?? '').trim();
  if (!text) return '';
  const sents = text
    .split(/(?<=[。！？!?；;.])\s*/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= minLen);
  if (!sents.length) return '';
  const score = (s) => {
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const decision = /(应该|得先|先|别|要|因为|所以|问题|下次|其实|但是|而是|should|need|next|because|but|so|instead)/i.test(s) ? 30 : 0;
    return cjk * 2 + decision + Math.min(60, s.length);
  };
  const best = sents.map((s) => ({ s, v: score(s) })).sort((a, b) => b.v - a.v)[0];
  if (!best || best.s.length < minLen) return '';
  // [L3] 英文推理不是她的"念头"：摘要要"以中文为主"（≥2 个汉字且汉字占字母+汉字 ≥40%），
  // 否则不存——2026-10-30 实测有 50 条英文碎片、以及 "But also 主动机会 with 没人说话" 这类夹生句进 thoughts。
  const cjk = (best.s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = (best.s.match(/[A-Za-z]/g) ?? []).length;
  if (cjk < 2 || cjk / Math.max(1, cjk + latin) < 0.5) return '';
  return [...best.s].slice(0, maxLen).join('');
}

/** 这一回合要不要留全文（长思考才留，免得把日志写爆） */
export function shouldKeepFull(chars, minChars = 600) {
  return Number(chars) >= Number(minChars);
}

/** 失败回合要不要留一条经验候选：必须是失败回合，且摘要够长 */
export function candidateTextFrom(joined, { failed = false, minLen = 12 } = {}) {
  if (!failed) return '';
  const tail = reasoningTailText(joined, { minLen: 10 });
  if (tail.length < minLen) return '';
  return tail;
}
