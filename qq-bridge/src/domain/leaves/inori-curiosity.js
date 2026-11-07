// inori-curiosity.js · 好奇回路：她"挂心着的事"（open loops）
// 设计原则（用户规格）：不任务化。这只是个容器——她自己决定什么时候挂上一件、
// 什么时候放下。系统不催、不替她做、不把它变成待办；超过 14 天没人再提就自然沉底（不删）。
// 纯模块：无 IO，无定时器。状态 = {loops: [{text, source, ts, seenAt}] }。

const PRUNE_DAYS = 14;      // 超期才物理清掉（之前只是沉底）
const MAX_ACTIVE = 12;      // 最多挂 12 件，再多按最旧的沉掉
const DAY = 24 * 3600000;

const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');

/** 挂上一件惦记的事。返回新状态。重复的（同一件再提）刷新时间戳而不是加一条。 */
export function record(state, item, now = Date.now()) {
  const s = { loops: [...(state?.loops ?? [])] };
  const text = String(item?.text ?? '').slice(0, 120);
  if (!text.trim()) return s;
  const n = norm(text);
  const i = s.loops.findIndex((l) => norm(l.text) === n);
  if (i >= 0) {
    s.loops[i] = { ...s.loops[i], ts: now, source: String(item?.source ?? s.loops[i].source ?? '').slice(0, 60) || s.loops[i].source };
  } else {
    s.loops.push({ text: text.trim(), source: String(item?.source ?? '').slice(0, 60), ts: now });
  }
  // 新挂的排最前
  s.loops.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const active = s.loops.filter((l) => now - l.ts < PRUNE_DAYS * DAY);
  s.loops = active.slice(0, MAX_ACTIVE * 2); // 保留一些"沉底的"，渲染时降权
  return s;
}

/** 放下（她不想惦记了 / 已经自己看过想明白了） */
export function forget(state, matchText, now = Date.now()) {
  const s = { loops: [...(state?.loops ?? [])] };
  const n = norm(matchText);
  s.loops = s.loops.filter((l) => !(norm(l.text) === n || (n && norm(l.text).includes(n))));
  return s;
}

/** 当前可挂心渲染的（14 天内、最多 4 件） */
export function openLoops(state, now = Date.now()) {
  return (state?.loops ?? [])
    .filter((l) => now - l.ts < PRUNE_DAYS * DAY)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 4);
}

/**
 * 渲染成轮素材里的一行。措辞纪律：只给事实 + 给许可（想接才接），绝不写"应该/挑一件做"。
 * 没挂心着的事就返回 null（不给空行，不制造"你该做点什么"的暗示）。
 */
export function renderLine(state, now = Date.now()) {
  const loops = openLoops(state, now);
  if (!loops.length) return null;
  const lines = loops.map((l, i) => {
    const days = Math.max(0, Math.round((now - l.ts) / DAY));
    const src = l.source ? `（来自${l.source}）` : '';
    return `${i + 1}. ${l.text}${src}${days >= 2 ? ` · 挂心 ${days} 天了` : ''}`;
  });
  return `你挂心着的事（不催：想接就哪天顺手接了，不想接就让它继续沉着）：\n${lines.join('\n')}`;
}

/** 统计（供反思素材/行为账，纯事实不评价） */
export function stats(state, now = Date.now()) {
  const loops = state?.loops ?? [];
  return {
    open: loops.filter((l) => now - l.ts < PRUNE_DAYS * DAY).length,
    settled: loops.filter((l) => now - l.ts >= PRUNE_DAYS * DAY).length,
  };
}
