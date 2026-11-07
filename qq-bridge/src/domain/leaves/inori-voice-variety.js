// inori-voice-variety.js · 说话多样性：只看她自己的最近发言，找「开头/长度」重复
//
// 纪律：这不是学她自己的话（学习素材只取别人的话）；这是**反重复提示**——
// 同一种开头、同一种长度连着用，读起来就像复读机。只递事实+许可，不命令。
const OPEN_LEN = 2;

function clean(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

function opening(t) {
  const s = clean(t).replace(/^[「『“"'（(【\[]+/, '');
  return [...s].slice(0, OPEN_LEN).join('');
}

function bucket(len) {
  if (len <= 4) return 'short';
  if (len <= 8) return 'mid';
  if (len <= 15) return 'long';
  return 'xlong';
}

export function analyzeVoice(texts) {
  const list = (Array.isArray(texts) ? texts : []).map(clean).filter(Boolean).slice(-10);
  const opens = new Map();
  const buckets = new Map();
  for (const t of list) {
    const o = opening(t);
    if (o) opens.set(o, (opens.get(o) || 0) + 1);
    const b = bucket([...t].length);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  const topOpen = [...opens.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const topBucket = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return {
    count: list.length,
    topOpen: topOpen ? { text: topOpen[0], n: topOpen[1] } : null,
    topBucket: topBucket ? { bucket: topBucket[0], n: topBucket[1] } : null,
    lastLen: list.length ? [...list[list.length - 1]].length : 0,
  };
}

/** 近期她自己发言里的重复模式 → 一行提示；样本不足或无重复返回 null */
export function renderVoiceVarietyHint(ownTexts, { minSamples = 5 } = {}) {
  const a = analyzeVoice(ownTexts);
  if (a.count < minSamples) return null;
  const parts = [];
  if (a.topOpen && a.topOpen.n >= 3 && a.topOpen.text.length >= 2) {
    parts.push(`你最近 ${a.count} 条里有 ${a.topOpen.n} 条是「${a.topOpen.text}」开头`);
  }
  if (a.topBucket && a.topBucket.n / a.count >= 0.75 && ['short', 'mid', 'long', 'xlong'].includes(a.topBucket.bucket)) {
    const label = { short: '四五字', mid: '六到八字', long: '九到十五字', xlong: '很长' }[a.topBucket.bucket];
    parts.push(`大半都是${label}`);
  }
  if (!parts.length) return null;
  return `【说话别一个模子】${parts.join('，')}。换个开头、换个长短都行，不想换也就这样。`;
}
