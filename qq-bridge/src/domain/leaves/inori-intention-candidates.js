// inori-intention-candidates.js · 候选池：把 wish/curiosity/goal/day-plan 合成一份“可以接的事”
//
// 只做候选，不创建意图。她可以用 qq_intention add 把某件挂到自己名下；
// 不选、放着、去做别的，也都是合法选择。
//
// 纪律：不排序成待办，不按数量考核；候选最多 4 条，去重。

function clean(s, max = 80) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function push(out, seen, { id, text, source, why = '' }) {
  const body = clean(text);
  if (!body) return;
  const k = body;
  if (seen.has(k)) return;
  seen.add(k);
  out.push({ id: id || k, text: body, source, why: clean(why, 60) });
}

export function buildIntentionCandidates({ wishes = [], curiosity = [], goals = [], dayPlan = [] } = {}, { max = 4 } = {}) {
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(wishes) ? wishes : []) {
    if (w?.done) continue;
    push(out, seen, { id: w?.id, text: w?.wish ?? w?.text, source: 'wish', why: w?.source });
  }
  for (const c of Array.isArray(curiosity) ? curiosity : []) {
    push(out, seen, { id: c?.id, text: c?.text ?? c?.title, source: 'curiosity', why: c?.source });
  }
  for (const g of Array.isArray(goals) ? goals : []) {
    // [GOAL-STATUS] goals 用 status 字段；只把还在候选里的拿出来，done/dropped 不能又冒出来。
    if (g?.done || g?.completed || ['done', 'dropped', 'promoted'].includes(String(g?.status || ''))) continue;
    push(out, seen, { id: g?.id, text: g?.text ?? g?.title ?? g?.goal, source: 'goal' });
  }
  for (const d of Array.isArray(dayPlan) ? dayPlan : []) {
    if (d?.done) continue;
    push(out, seen, { id: d?.id, text: d?.what ?? d?.text, source: 'day-plan', why: d?.at });
  }
  return out.slice(0, Math.max(1, Number(max) || 4));
}

export function renderIntentionCandidates(items = []) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x?.text);
  if (!list.length) return '';
  const lines = list.map((x) => `- ${x.text}${x.why ? `（${x.why}）` : ''}`);
  return `【可以接的事】\n${lines.join('\n')}\n选不选、选哪件都行；想挂到自己名下再用 qq_intention。`;
}
