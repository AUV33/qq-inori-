// inori-browse-learn.js · 逛帖子 → 语言学习素材（确定性抽词，零 LLM）
//
// 逛帖子的正文里出现的网络用语/新词，抽成黑话候选交给原有的词库判定链路
// （她之后自己 confirm/reject）。只收正文、不下结论；不学她自己的话。
const STOP = new Set('的了是在有和就不都一个我你他她它们这那什么怎么然后还是因为所以但是而且可以没有我们你们他们现在今天明天昨天说道说着时候一下一会这样那样自己知道觉得如果想会要能吧呢啊吗哦嗯还有这个那个真的不是就是这样子我们他们你们她们'.split(''));

const CJK = /[\u4e00-\u9fff]/;

function cleanText(t) {
  return String(t ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^\u4e00-\u9fff0-9A-Za-z]+/g, ' ')
    .trim();
}

/** 从若干段正文里抽高频词（2~4 字），排除停用字/已知词 */
export function extractTerms(texts, { known = new Set(), minFreq = 2, maxTerms = 8, minLen = 2, maxLen = 4 } = {}) {
  const freq = new Map();
  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = cleanText(raw);
    if (!text) continue;
    const segs = text.split(/\s+/).filter(Boolean);
    for (const seg of segs) {
      for (let n = minLen; n <= maxLen; n += 1) {
        for (let i = 0; i + n <= seg.length; i += 1) {
          const w = seg.slice(i, i + n);
          if (!CJK.test(w)) continue;
          if ([...w].some((ch) => STOP.has(ch))) continue;
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
    }
  }
  const knownHas = (w) => {
    if (known.has(w)) return true;
    for (const k of known) { if (k && (k.includes(w) || w.includes(k))) return true; }
    return false;
  };
  const picked = [];
  const sorted = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length));
  for (const [w, n] of sorted) {
    if (n < minFreq) continue;
    if (knownHas(w)) continue;
    // 跳过被已选长词包含的碎片（避免「三角/角洲」）
    if (picked.some((p) => p.includes(w) || w.includes(p))) continue;
    picked.push(w);
    if (picked.length >= maxTerms) break;
  }
  return picked;
}
