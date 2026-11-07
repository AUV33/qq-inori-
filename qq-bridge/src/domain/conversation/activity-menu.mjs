// activity-menu.mjs · 「闲着也能干点什么」的备选（纯函数，零 IO）
//
// 为什么（2026-10-30 主人拍板两次）：
//   1) 玩方舟是**可选活动**，不是待办；
//   2) 「随机一点吧，别催她干什么」——所以这一层是**随机出现、随机顺序、只当备选**，
//      不是每小时必现的清单。固定顺序 + 每小时必现 = 软性催促，方舟永远排第一就是在指路。
//
// 纪律：活动名只来自技能库的 `activity` 字段（数据）；代码里不写任何 App 名 / 包名 / 别名表。
//       措辞只给事实 + 许可：不写注入次数、成功数，也不用「你能挑」「想玩哪个就打开」这类祈使句。

/** 按 activity 归组：跳过退役/归档/没写活动名的；顺序由调用方打乱（这里不排序，避免固定引导）。 */
export function groupActivities(items) {
  const map = new Map();
  for (const s of Array.isArray(items) ? items : []) {
    if (!s || s.retired || s.archived) continue;
    const name = String(s.activity || '').trim();
    if (!name) continue;
    const hit = map.get(name) || { activity: name, count: 0 };
    hit.count += 1;
    map.set(name, hit);
  }
  return [...map.values()];
}

/** Fisher–Yates，可注入 rng（测试要可复现）。 */
function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 渲染「备选」段。两次随机：先决定这一次出不出（chance），再随机挑 limit 个、随机顺序。
 * 没出、没可选项都返回 ''（不补“补偿性出现”）。
 * @param {Array} items 技能库 items
 * @param {{limit?:number, chance?:number, rng?:() => number}} [opts]
 */
export function renderActivityMenu(items, { limit = 2, chance = 0.3, rng = Math.random, extraActivities = [] } = {}) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  const p = Number(chance);
  if (!Number.isFinite(p) || p <= 0) return '';
  if (roll() >= p) return '';
  const groups = groupActivities(items);
  // [FREEDOM-OPTIONS] 活动池不只来自技能库：activities.json 的 _pool 是泛活动，
  // 没有技能归属也能出现；不写 app 名、不写步骤，只给名字。
  const seen = new Set(groups.map((g) => g.activity));
  for (const raw of Array.isArray(extraActivities) ? extraActivities : []) {
    const name = String(raw && typeof raw === 'object' ? raw.activity ?? raw.name : raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    groups.push({ activity: name, count: 0 });
  }
  if (!groups.length) return '';
  const picked = shuffled(groups, roll).slice(0, Math.max(1, Number(limit) || 1));
  const list = picked.map((g) => (g.count > 0 ? `${g.activity}（${g.count} 件）` : g.activity)).join('、');
  return `\n\n【备选】可以做的事：${list}。不用现在决定，想干就干，不想干就发呆。`;
}
