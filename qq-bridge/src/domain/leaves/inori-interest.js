// inori-interest.js · 「遇到」驱动的兴趣/好奇（纯模块，可单测）
//
// 设计（2026-10-26 用户拍板）：
//   机制 = 遇到不认识的 → 好奇；遇到喜欢的 → 感兴趣。
//   不是 harness 安排"你要对什么感兴趣"，而是把「她遇到了什么」记成事实，
//   下一次有动静时把事实递到她眼前，要不要追、要不要看，由她定。
//
// 纪律：只记事实（她说了什么/看到了什么）+ 给许可（想看就看，不想就放着），
//       不评价、不催、不派活、不产生"你该做点什么"的暗示。

const DAY = 24 * 3600000;
const PRUNE_DAYS = 7;
const MAX_KEEP = 60;

const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);

// 她"喜欢/被戳中"的表达（她自己说的才算，不替她判断）
const LIKE_PATTERNS = [
  /好可爱|可爱死|太可爱/,
  /好喜欢|我喜欢|喜欢这|喜欢上/,
  /好想吃|想吃|好喝|好香/,
  /好听|好看|好漂亮|好帅|好美/,
  /爱了|绝了|笑死|笑死我了|哈哈{2,}|好玩|有意思|好有趣|有趣/,
  /太戳|戳我|戳中|心动|想要|想买|想玩|想听|想看/,
  /收藏了|存了|截屏了|记下了/,
];

/** 从她自己发的话里找"喜欢/被戳中"的句子片段；没有就返回 null。 */
export function detectLikes(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const re of LIKE_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      // 取命中词前后各 20 字作为"她在说的事"的片段
      const i = Math.max(0, m.index - 20);
      const j = Math.min(s.length, m.index + m[0].length + 20);
      return { phrase: m[0], snippet: norm(s.slice(i, j)) };
    }
  }
  return null;
}

/** 记一次「遇到」：kind=unknown（不认识）| like（喜欢/被戳中）。重复的刷新时间戳。 */
export function recordEncounter(state, item, now = Date.now()) {
  const s = { items: [...(state?.items ?? [])] };
  const kind = item?.kind === 'like' ? 'like' : 'unknown';
  const what = norm(item?.what);
  if (!what) return s;
  const src = String(item?.src ?? '').slice(0, 30);
  const i = s.items.findIndex((x) => x && x.kind === kind && norm(x.what) === what);
  if (i >= 0) {
    s.items[i] = { ...s.items[i], at: now, src: src || s.items[i].src };
  } else {
    s.items.push({ kind, what, src, at: now });
  }
  s.items.sort((a, b) => (b.at || 0) - (a.at || 0));
  s.items = s.items.filter((x) => now - Number(x.at || 0) < PRUNE_DAYS * DAY).slice(0, MAX_KEEP);
  return s;
}

/** 最近 24h 的「遇到」，最多 6 条（unknown 与 like 分开列）。 */
export function openEncounters(state, now = Date.now()) {
  const items = (state?.items ?? []).filter((x) => x && now - Number(x.at || 0) < DAY);
  const unk = items.filter((x) => x.kind === 'unknown');
  const like = items.filter((x) => x.kind === 'like');
  return {
    unknown: unk.slice(0, 3),
    like: like.slice(0, 2),
  };
}

/** 渲染成轮素材：只给事实 + 给许可；都空返回 null。 */
export function renderEncounterLine(state, now = Date.now()) {
  const { unknown, like } = openEncounters(state, now);
  if (!unknown.length && !like.length) return null;
  const lines = [];
  if (unknown.length) {
    lines.push(`最近碰到几个你还不认识的东西：${unknown.map((x) => `${x.what}${x.src ? `（来自${x.src}）` : ''}`).join('、')}。心里痒就去弄明白，不痒就放着。`);
  }
  if (like.length) {
    lines.push(`最近你对这些有点兴趣：${like.map((x) => `「${x.what}」`).join('、')}。想再看就再看，不想就算。`);
  }
  return `【你遇到的东西】${lines.join('\n')}`;
}

export default recordEncounter;
