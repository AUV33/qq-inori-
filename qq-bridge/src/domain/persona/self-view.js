// self-view.js · 「我的状态」一次拿全（qq_me 的数据与渲染，纯函数无 IO）
//
// 背景（2026-11-03）：提示词目录里原本给了 5 条入口（self_note / day_plan / my_day /
// cognition / memory_query），但它们都不在常驻工具面（core profile 只常驻 41 个），
// 她照着目录直接调会 not found，只能绕 qq_tools。与其给 5 个半通入口，不如给一个常驻的
// 复合只读工具 qq_me：一次把自己的状态取全，schema 只多一个 section。
//
// 纪律：
//   · 每段独立取、独立失败：一段没取到只标"没取到"，不影响其它段；
//   · 每段有字数帽，整段有总帽；超了就让她用 section=xxx 单独取（可追回，不静默丢）；
//   · 只读：这里不写任何状态。

/** 一段"我自己的状态"：id=工具参数，label=提示词里的抬头，cap=单段字数帽。 */
export const ME_SECTIONS = Object.freeze([
  {
    id: 'self',
    label: '我写过的（我自己的话）',
    method: 'POST',
    path: () => '/api/socialV2/self-note',
    body: () => ({ action: 'get' }),
    cap: 700,
  },
  {
    id: 'plan',
    label: '今天给自己定的',
    method: 'POST',
    path: () => '/api/socialV2/day-plan',
    body: (key) => ({ key, action: 'get' }),
    cap: 600,
  },
  {
    id: 'day',
    label: '我最近干过什么',
    method: 'GET',
    path: (key) => `/api/socialV2/my-day?key=${encodeURIComponent(key)}&days=1`,
    cap: 700,
  },
  {
    id: 'cognition',
    label: '我攒下的认知',
    method: 'GET',
    path: (key) => `/api/socialV2/cognition?key=${encodeURIComponent(key)}&limit=8`,
    cap: 700,
  },
  {
    id: 'facts',
    label: '关于他的长期事实',
    method: 'GET',
    path: (key) => `/api/socialV2/memory?key=${encodeURIComponent(key)}&category=fact`,
    cap: 600,
  },
  {
    id: 'curiosity',
    label: '我挂着的（想知道/想做的）',
    method: 'POST',
    path: () => '/api/socialV2/curiosity',
    body: (key) => ({ key, action: 'list' }),
    cap: 400,
  },
]);

export const ME_SECTION_IDS = Object.freeze(ME_SECTIONS.map((s) => s.id));

/**
 * 按 section 取要跑的那几段：'all'（或缺省）取全部；未知 id 返回空数组（由调用方报错）。
 * @param {string} [section]
 */
export function sectionsFor(section = 'all') {
  const want = String(section ?? 'all').trim() || 'all';
  if (want === 'all') return ME_SECTIONS.slice();
  return ME_SECTIONS.filter((s) => s.id === want);
}

function truncate(text, cap) {
  const body = String(text ?? '');
  const limit = Math.max(0, Number(cap) || 0);
  if (!limit || body.length <= limit) return body;
  return `${body.slice(0, limit)}…（截了，用 section 单独取可看全）`;
}

/**
 * 渲染成一段给模型的话。results: [{ id, label, text?, error?, cap? }]（顺序即展示顺序）。
 * @param {Array<object>} results
 * @param {{maxChars?:number}} [opts]
 */
export function renderMeView(results, { maxChars = 3000 } = {}) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  const head = '【我的状态】';
  const limit = Math.max(200, Number(maxChars) || 3000);
  const out = [head];
  let total = head.length;
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const block = r.error
      ? `【${r.label}】（没取到：${String(r.error).slice(0, 120)}）`
      : `【${r.label}】\n${truncate(r.text, r.cap)}`;
    if (total + block.length + 2 > limit) {
      const rest = list.slice(i).map((x) => x.id).filter(Boolean).join('/');
      out.push(`（后面还有 ${list.length - i} 段没展开${rest ? `：${rest}` : ''}；用 section="<id>" 单独取）`);
      break;
    }
    out.push(block);
    total += block.length + 2;
  }
  return out.join('\n\n');
}
