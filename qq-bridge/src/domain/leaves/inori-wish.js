// inori-wish.js · 「她想自己干的事」（自发起管线，用户拍板 2026-10-25：a 自唤醒 + b 愿望容器）
// 设计：愿望归她。系统只做三件事：记得住（record）、到点叫醒她（due）、记上「已交付」（markRun）。
// 不催、不替她执行、不任务化；14 天没人理就自然沉底（不删）。
// 纯模块：无 IO，无定时器。state = { items: [{id, wish, key, source, at, runAt, done, doneAt}] }
// key 为空 = owner 私聊；runAt=0 = 没排期（只挂着）；交付过一次 runAt 归零（不重复叫醒）。

const PRUNE_DAYS = 14;
const MAX_ACTIVE = 12;
const MAX_OPEN = 4;
const DAY = 24 * 3600000;
const MIN = 60000;

const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');

/** 记一件「想干的事」。inMinutes=0 表示尽快；重复的（同愿望同会话）刷新时间而不是加一条。 */
export function recordWish(state, item, now = Date.now()) {
  const s = { items: [...(state?.items ?? [])] };
  const wish = String(item?.wish ?? '').slice(0, 120);
  if (!wish.trim()) return s;
  const key = String(item?.key ?? '').slice(0, 60);
  // [UNIT-FIX] 上限是 7 天（分钟），原来写成 `7 * 24` = 168 **分钟**（约 2.8 小时）：
  // 她排「明早再叫我」这种超过 2.8 小时的愿望会被悄悄提前到 2.8 小时后叫醒。
  const inMin = Math.max(0, Math.min(7 * 24 * 60, Number(item?.inMinutes) || 0));
  const n = norm(wish);
  const i = s.items.findIndex((x) => !x.done && norm(x.wish) === n && x.key === key);
  const runAt = now + inMin * MIN;
  if (i >= 0) {
    const x = s.items[i];
    x.at = now;
    x.runAt = runAt;
    x.done = false;
    x.doneAt = 0;
    x.source = String(item?.source ?? x.source ?? '').slice(0, 60) || x.source;
  } else {
    s.items.push({
      id: `${String(now).slice(-10)}-${Math.floor(Math.random() * 1e4)}`,
      wish: wish.trim(),
      key,
      source: String(item?.source ?? '').slice(0, 60),
      at: now,
      runAt,
      done: false,
      doneAt: 0,
    });
  }
  s.items.sort((a, b) => (b.at || 0) - (a.at || 0));
  s.items = s.items.filter((x) => now - x.at < PRUNE_DAYS * DAY).slice(0, MAX_ACTIVE * 2);
  return s;
}

/** 关闭一件（不想干了 / 干完了）。前缀匹配。 */
export function doneWish(state, matchText, now = Date.now()) {
  const s = { items: [...(state?.items ?? [])] };
  const n = norm(matchText);
  s.items = s.items.map((x) => (n && (norm(x.wish) === n || norm(x.wish).includes(n))) ? { ...x, done: true, doneAt: now } : x);
  return s;
}

/** 当前挂着的（14 天内、未关闭、最多 4 件）。 */
export function openWishes(state, now = Date.now()) {
  return (state?.items ?? [])
    .filter((x) => !x.done && now - x.at < PRUNE_DAYS * DAY)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, MAX_OPEN);
}

/** 到点未交付的（runAt>0 且已过点、还没叫过）。 */
export function dueWishes(state, now = Date.now()) {
  return (state?.items ?? []).filter((x) => !x.done && x.runAt > 0 && now >= x.runAt);
}

/** 交付过的标记（runAt 归零：不重复叫醒，愿望仍挂着等她关掉或自然沉底）。 */
export function markRun(state, ids, now = Date.now()) {
  const set = new Set(ids);
  const s = { items: [...(state?.items ?? [])] };
  s.items = s.items.map((x) => (set.has(x.id) ? { ...x, runAt: 0 } : x));
  return s;
}

/**
 * 渲染成轮素材里的一行。措辞纪律与 curiosity 同一条：只给事实 + 给许可，不写「应该/挑一件」。
 * 没有挂着的愿望返回 null（不给空行，不制造暗示）。
 */
export function renderWishLine(state, now = Date.now()) {
  const open = openWishes(state, now);
  if (!open.length) return null;
  const lines = open.map((w, i) => {
    const mins = Math.max(0, Math.round((w.runAt - now) / MIN));
    const when = w.runAt > now ? `（约 ${mins} 分钟后到点）` : '（在等空档）';
    const src = w.source ? `（来自${w.source}）` : '';
    return `${i + 1}. ${w.wish}${src} ${when}`;
  });
  return `你想自己干的事（不催：想做就做，哪件不想干了就用 qq_wish done 自己关掉）：\n${lines.join('\n')}`;
}

export default recordWish;
