// inori-dayplan.mjs · 「今天做什么」是她自己定的，不是系统抽的
//
// 设计约束（来自主人的要求）：
//   - 日程由她自己决定：模块只负责**校验 / 存档 / 按时间取当前那一条**，从不随机生成、从不替她编事件。
//   - 没有安排就是没有：渲染时明说"今天还没定"，绝不用模板/随机填充凑一个"她今天在做…"。
//   - 时间用本地时钟（HH:mm），取"at <= 现在"的最后一条作为"此刻你在做什么"。
//
// 纯函数模块：不读文件、不写文件、不 import 项目内其它模块（落盘由调用方负责）。

export const MAX_ITEMS = 6;
export const MAX_WHAT = 40;
export const MAX_MOOD = 12;
export const MAX_DETAIL = 60;

export function dayKeyOf(d = new Date()) {
  return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地）
}

/** "HH:mm" → 当天分钟数；非法返回 null */
export function minutesOf(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clip(text, n) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = clip(raw.at, 5);
  const what = clip(raw.what ?? raw.title ?? raw.text, MAX_WHAT);
  if (!what) return null;
  const minutes = minutesOf(at);
  if (minutes === null) return null;
  return {
    at,
    minutes,
    what,
    mood: clip(raw.mood, MAX_MOOD),
    detail: clip(raw.detail, MAX_DETAIL),
    done: raw.done === true,
  };
}

/**
 * 校验并规范化一份日程。
 * 只保留合法的条目；同一天最多 MAX_ITEMS 条；按时间排序。
 * 不补默认条目——她没定就是空的。
 */
export function normalizePlan(raw, { now = new Date() } = {}) {
  const date = clip(raw?.date, 10) || dayKeyOf(now);
  const list = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];
  const seen = new Set();
  for (const r of list) {
    const it = normalizeItem(r);
    if (!it) continue;
    const key = `${it.at}|${it.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  items.sort((a, b) => a.minutes - b.minutes);
  return { date, items, updatedAt: clip(raw?.updatedAt, 32) };
}

/** 今天是否已经定过（日期对得上且有条目） */
export function isTodayPlan(plan, now = new Date()) {
  return !!plan && plan.date === dayKeyOf(now) && Array.isArray(plan.items) && plan.items.length > 0;
}

/** 此刻那一条：at <= 现在 的最后一条；都在将来/今天没定 → null */export function currentItem(plan, now = new Date()) {
  if (!isTodayPlan(plan, now)) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let hit = null;
  for (const it of plan.items) {
    if (it.minutes <= nowMin) hit = it;
    else break;
  }
  return hit;
}

function line(it) {
  const bits = [];
  if (it.mood) bits.push(`（${it.mood}）`);
  let s = `${it.at} ${it.what}${bits.join('')}`;
  if (it.detail) s += `｜可以提：${it.detail}`;
  if (it.done) s += '｜已经做完了';
  return s;
}

/**
 * 注入文本。
 * - 今天定过：列出安排 + 一句「此刻你」，并给许可（想拿它开口就拿，不想提就不提）。
 * - 今天没定：明说没定，并说明可以自己定；**不编造任何事**。
 */
export function renderDayPlanBlock(plan, { now = new Date(), maxItems = 4, lifeState = null } = {}) {
  if (!isTodayPlan(plan, now)) {
    return '【今天还没定】今天你还没给自己安排过什么。想定就自己定：用 qq_day_plan 写 3–5 件（几点、在做什么、什么心情、一个能随口提的细节）；不想定也行——那就别现编自己"在做某事"。\n\n';
  }
  const shown = plan.items.slice(0, maxItems).map((it) => `- ${line(it)}`).join('\n');
  const cur = currentItem(plan, now);
  // [DAYPLAN-LIFE] 日程以前完全不看生活状态：她睡着了，prompt 还在说「这个点你在画画」。
  // 现在把真实状态（睡/很困/精神）接进来——计划还是她的，但口供应跟身体一致。
  const sleeping = String(lifeState?.state || '') === 'sleep';
  const curLine = sleeping
    ? (cur
      ? `【此刻你】按安排这个点你本来在${cur.what}，但你已经睡了——真醒着再说它。`
      : '【此刻你】你已经睡了，今天的事等你醒了再看。')
    : (cur
      ? `【此刻你】按你自己的安排，这个点你在${cur.what}${cur.mood ? `，心里${cur.mood}` : ''}${cur.detail ? `（手边：${cur.detail}）` : ''}。想拿它开口就拿，不想提就当背景。`
      : '【此刻你】今天第一件事还没到点，你还在自己的空档里。');
  return `【你今天给自己定的】（这些是你自己排的，不是任务清单，做不做、改不改都随你）\n${shown}\n${curLine}\n\n`;
}
