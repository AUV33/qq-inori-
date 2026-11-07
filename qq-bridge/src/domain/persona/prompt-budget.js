// prompt-budget.js · 唤醒提示的预算计量（按【块】切开，量出谁在吃预算）
//
// 现在的语境是 20+ 个注入块平铺进一个字符串，只有总字数、没有分块账。
// 结果：6000 字上限靠"事后截断"兜，谁超了、超多少，没人知道。
// 这里不改注入逻辑，只做两件事：
//   1. 把 prompt 按【标题】切块，算每块字数与占比；
//   2. 给出告警：总长超预算 / 单块过大 / 块数过多。
// 纯函数，供投递日志与测试共用。
// [DEAD-CODE] 2026-11-03 删掉 analyzePromptFile 与随之而来的 `import fs`：
// 它是给"离线分析保存下来的 prompt 文件"用的调试口，零调用者，还让这个本应纯函数的模块带上 IO。

// ── 场景预算（唯一口径，wake-sender 与 wake-prompt 共用）──────────────────
// [ROLE-FULL-BUDGET] 2026-11-03 主人决定群聊也整卡注入（d5ac935），群聊预算必须跟着
// 卡片体积走：旧值 9000 是按「群聊只注入 900 字角色卡」定的；整卡 7935 字时
// 固定 9000 会让 base 自己就超预算，硬上限只能把群像/群事实/关系/表情包全部丢掉。
// 16000 = 旧 9000 + 整卡比 900 多出的约 7000，动态注入空间与旧行为基本持平。
// 私聊维持 14000（它一直按整卡算的）。
export const SCENE_BUDGETS = Object.freeze({ private: 14000, group: 16000 });
// 注入层预留：基底（消息快照/人设/收尾）之外留给记忆/群像/自我等注入块的空间。
export const INJECTION_RESERVE = 1500;
// 提示词主次的旧固定上限：core+ref 一旦超过它，装饰层会被全部裁掉（2026-11-03 实测 10.6k）。
export const LEGACY_TIER_MAX = 7600;

/**
 * 提示词分层预算（实测动态）：
 *   基底 = core（这一轮要做什么）+ ref（参考），必须留；
 *   装饰层按「至少留 decoFloor 字」给空间，同时整体不超过 场景预算 − 注入预留。
 * 旧的固定 7600 只在 core+ref 很小时兜底（不让装饰层无节制膨胀）。
 *
 * @param {{coreLen?:number, refLen?:number, sceneBudget?:number,
 *          reserve?:number, decoFloor?:number, legacyMax?:number}} [opts]
 * @returns {{ceiling:number, base:number, decoFloor:number, sceneBudget:number, reserve:number, mode:'measured'|'legacy'}}
 */
export function planTierBudget({
  coreLen = 0, refLen = 0, sceneBudget = SCENE_BUDGETS.private,
  reserve = INJECTION_RESERVE, decoFloor = 600, legacyMax = LEGACY_TIER_MAX,
} = {}) {
  const base = Math.max(0, Number(coreLen) || 0) + Math.max(0, Number(refLen) || 0);
  const floor = Math.max(0, Number(decoFloor) || 0);
  const legacy = Math.max(0, Number(legacyMax) || 0);
  // 这一轮最多能用到多少（场景预算 − 注入预留）；基底本身就能超，所以下界以基底为准
  const allowed = Math.max(0, (Number(sceneBudget) || 0) - Math.max(0, Number(reserve) || 0));
  // 想要的 = 至少给装饰层 floor 字；但旧口径 7600 仍兜底，避免装饰层无节制膨胀
  const desired = Math.max(legacy, base + floor);
  const ceiling = Math.max(base, Math.min(desired, Math.max(allowed, base)));
  return {
    ceiling,
    base,
    decoFloor: floor,
    sceneBudget: Number(sceneBudget) || 0,
    reserve: Number(reserve) || 0,
    mode: ceiling > legacy ? 'measured' : 'legacy',
  };
}

/**
 * 分层预算（advisory，只计量不裁剪）：core / ref / deco 三层各自的上限。
 * core 先拿固定份额（默认 60%），ref 拿剩下的；deco 用剩余空间 + 保底。
 * 给日志与后续按层分配用；真正的裁剪仍在 wake-prompt 的 ceiling 逻辑。
 */
export function planTierBudgets({
  coreLen = 0, refLen = 0, sceneBudget = SCENE_BUDGETS.private, reserve = INJECTION_RESERVE,
  decoFloor = 600, coreShare = 0.6,
} = {}) {
  const usable = Math.max(0, (Number(sceneBudget) || 0) - Math.max(0, Number(reserve) || 0));
  const share = Math.min(0.9, Math.max(0.1, Number(coreShare) || 0.6));
  const coreCap = Math.round(usable * share);
  const refCap = Math.max(0, usable - coreCap);
  const decoCap = Math.max(Number(decoFloor) || 0, usable - Math.max(0, Number(coreLen) || 0) - Math.max(0, Number(refLen) || 0));
  return {
    usable, coreCap, refCap, decoCap, coreShare: share,
    exceeded: {
      core: (Number(coreLen) || 0) > coreCap,
      base: (Number(coreLen) || 0) + (Number(refLen) || 0) > usable,
    },
  };
}

export const BLOCK_RE = /【([^】\n]{1,24})】/g;

/**
 * 按【标题】切块。第一个标题之前的内容记为「基底」。
 * @returns {{total:number, blocks:{label:string, chars:number}[], blockCount:number}}
 */
export function segmentPrompt(text) {
  const body = String(text ?? '');
  const marks = [];
  for (const m of body.matchAll(BLOCK_RE)) marks.push({ label: m[1], index: m.index });
  const blocks = [];
  if (!marks.length) return { total: body.length, blocks: [], blockCount: 0 };
  if (marks[0].index > 0) blocks.push({ label: '基底', chars: marks[0].index });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const label = marks[i].label;
    // 同名块合并（同一标题可能出现两次，比如两个【事实】）
    const exist = blocks.find((b) => b.label === label);
    if (exist) exist.chars += end - start;
    else blocks.push({ label, chars: end - start });
  }
  return { total: body.length, blocks, blockCount: marks.length };
}

/** 摘要：总长、块数、占比最高的几块 */
/**
 * [SEGMENT-HEAD] 与 mergeBlocks/compactInjection/enforceInjectionBudget 同一口径：
 * 只认**行首**的【标题】。旧 segmentPrompt 用任意位置匹配，角色卡正文里那句
 * “群里只有带【他】标记的……”会把整卡切成 4509+3437 两块，块清单和告警全失真。
 * 保留 segmentPrompt 的旧行为给兼容调用，日志/告警一律走这个。
 */
export function segmentPromptBlocks(text) {
  const body = String(text ?? '');
  const marks = [];
  for (const m of body.matchAll(HEAD_RE)) marks.push({ label: m[1], start: m.index + (m[0].startsWith('\n') ? 1 : 0) });
  const blocks = [];
  if (!marks.length) return { total: body.length, blocks: [], blockCount: 0 };
  if (marks[0].start > 0) blocks.push({ label: '基底', chars: marks[0].start });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    const label = marks[i].label;
    const exist = blocks.find((b) => b.label === label);
    if (exist) exist.chars += end - start;
    else blocks.push({ label, chars: end - start });
  }
  return { total: body.length, blocks, blockCount: marks.length };
}

export function summarizePrompt(text, { top = 5 } = {}) {
  const seg = segmentPromptBlocks(text);
  const total = seg.total || 1;
  const ranked = seg.blocks
    .map((b) => ({ ...b, pct: Number(((b.chars / total) * 100).toFixed(1)) }))
    .sort((a, b) => b.chars - a.chars);
  return { total: seg.total, blockCount: seg.blockCount, top: ranked.slice(0, top), blocks: ranked };
}

/**
 * 预算告警：调用方通常传场景预算（wake-sender 传 private 14000 / group 16000）；
 * 这里的 9000 只是无参兜底。单块阈值不作用于人设块（整卡 7.9k 是预期值，告警只会变噪声）。
 * 这些阈值故意宽松，只用来抓"明显膨胀"，不做精细治理。
 */
export function budgetWarnings(summary, { maxTotal = 9000, maxBlock = 2000, maxBlocks = 25 } = {}) {
  const warnings = [];
  if (!summary || !summary.total) return warnings;
  if (summary.total > maxTotal) warnings.push(`提示总长 ${summary.total} 字 > ${maxTotal}（该裁了）`);
  if (summary.blockCount > maxBlocks) warnings.push(`注入块 ${summary.blockCount} 个 > ${maxBlocks}（块太多，模型分不清主次）`);
  for (const b of summary.top ?? []) {
    // 人设块本来就长（整卡 7.9k），拿 2000/3000 去告警只会产生每轮固定噪声，
    // 把真正该看的块淹没。总长告警仍然会覆盖人设膨胀。
    if (/当前角色|你自己/.test(b.label)) continue;
    if (b.chars > maxBlock) warnings.push(`块【${b.label}】${b.chars} 字 > ${maxBlock}`);
  }
  return warnings;
}

/** 一行日志用：总长 + 块数 + 前几块 */
export function formatBudgetLine(summary) {
  if (!summary || !summary.total) return '';
  const top = (summary.top ?? []).map((b) => `【${b.label}】${b.chars}`).join(' ');
  return `总 ${summary.total} 字 / ${summary.blockCount} 块 ｜ 最大：${top}`;
}

// ── 块合并 ────────────────────────────────────────────────────────────────
// 思路学记忆模块的 unifyEntries：同一件事的多个视图只留一份，不同视图并进一个块。
// 模型不缺信息，缺的是"哪几条是在说同一件事"——38 个平铺的块让它分不清主次。
// 只认同行首的【标题】（行内出现的【他】之类不算块，避免误切）。
const HEAD_RE = /(?:^|\n)【([^】\n]{1,24})】/g;

export const DEFAULT_MERGE_GROUPS = [
  // 群氛围：谁在群里、群怎么聊、群有多热——同一件事的几个视图，合成一块
  { title: '群里的动静', match: ['群里的人', '群友的印象', '这个群里的人', '这个群的习惯', '群倾向', '水群适应度', '参与度参考', '群摘要'] },
  // 开口与节奏：该不该说、什么时候说、等多久、怎么发——指令类合成一块，别散成 6 个碎块
  { title: '开口与节奏', match: ['积极性', '开口时机', '首回复节奏', '先回话', '当前唤醒', '唤醒', '怎么发', '上下文先行', '拒答也可见'] },
  // 自我：她最近的念头/变化/认知账（不含角色卡与「你自己」两张大块）
  // [FACT-UNMERGE] 「你手头的会话」是事实块（她在哪些会话里），不是自我笔记：
  // 并进「你最近」后会被 400 字帽截掉下半截，等于让她忘了自己还在别处说话。单独留着，不截。
  { title: '你最近', match: ['自我档案', '你最近的样子', '我最近在想', '有点不一样', '反思批的认知账', '我最近写下的', '我自己想到的', '你今天给自己定的'] },
  // 表情：策略 / 清单 / 这轮对得上的——模型只需要一个入口
  { title: '表情包', match: ['表情包策略', '可用表情包', '这轮对得上的表情', '表情包：', '表情包'] },
  // 状态：此刻几条事实（未读、最近一条、上次说话）合成一块
  { title: '现在的状态', match: ['你现在的状态', '此刻状态', '此刻你', '当前时间'] },
  // 说话方式与边界：反AI味 / 说话 / 这是群聊 / 网页是数据——同属"怎么在场"，合成一块
  { title: '说话与边界', match: ['反AI味', '说话', '这是群聊', '网页是数据'] },
];

/**
 * 把同类块合并成一个块（保持原有顺序与正文，不删信息）。
 * @param {string} text
 * @param {{title:string, match:string[]}[]} groups
 * @returns {string}
 */
export function mergeBlocks(text, groups = DEFAULT_MERGE_GROUPS) {
  const body = String(text ?? '');
  const marks = [];
  for (const m of body.matchAll(HEAD_RE)) {
    const lead = m[0].startsWith('\n') ? 1 : 0;
    marks.push({ label: m[1], start: m.index + lead });
  }
  if (marks.length < 2) return body;
  const canon = (label) => {
    for (const g of groups) if ((g.match || []).some((w) => label.includes(w))) return g.title;
    return null;
  };
  const segs = [];
  if (marks[0].start > 0) segs.push({ label: null, text: body.slice(0, marks[0].start) });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    segs.push({ label: marks[i].label, text: body.slice(marks[i].start, end) });
  }
  const order = [];
  const buckets = new Map();
  for (const s of segs) {
    const c = s.label ? canon(s.label) : null;
    const name = c || (s.label ? `\u0000${s.label}` : null);
    if (!name) { order.push({ raw: s }); continue; }
    if (!buckets.has(name)) { buckets.set(name, []); order.push({ name }); }
    buckets.get(name).push(s);
  }
  const out = [];
  for (const o of order) {
    if (o.raw) { out.push(o.raw.text); continue; }
    const list = buckets.get(o.name) || [];
    const merged = !o.name.startsWith('\u0000') && list.length > 1;
    if (merged) {
      const title = o.name;
      // 合并时保留每块自己的标签（降级成「- 标签：正文」而不是直接丢掉）：
      // 标签本身常带信息（水群适应度 / 群倾向（近48h 确定性聚合）），删了模型就少一层线索。
      const inner = list
        .map((s) => {
          const body = s.text.replace(/^【[^】\n]{1,24}】\s*/, '').trimEnd();
          if (!body) return '';
          return `- ${s.label}：${body}`;
        })
        .filter(Boolean)
        .join('\n');
      out.push(`【${title}】\n${inner}\n\n`);
    } else {
      out.push(...list.map((s) => s.text));
    }
  }
  return out.join('');
}

// ── 注入瘦身（[TOKEN-DIET]）────────────────────────────────────────────────
// 实测（2026-10-28）：每轮注入 12,750 字 / 43 块，全是全价 cacheMiss。
// 这里只做两件保守的事：
//   1) 把同义块合并；
//   2) 对白名单里的「长尾背景块」设单块上限，超了按行截断并标 …。
// **绝不碰**消息快照/未读/当前时间/收尾提示这些"事实块"——宁可省不全，不能让她看错消息。

// [TOKEN-DIET] 老表 `INJECTION_BLOCK_CAPS` 已删（2026-11-03 审计）：
// 它给「你自己 / 当前角色」设了 1000 字上限，而 2026-10-28 的教训正是"截人设会让发言变差"；
// 生产一直显式传 SAFE_INJECTION_CAPS，只有 `compactInjection()` 的无参调用会落到这张危险默认表上——
// 那是一条只有新调用方才会踩的静默地雷。默认值已改为下面的 SAFE 表。

// [PROMPT-DIET] 只裁「长尾背景块」的白名单：人设（当前角色/你自己）、消息快照、收尾、
// 工具协议、引用/回复类一律不在名单里——2026-10-28 那次把当前角色截到 1000 字，
// 直接表现是发言变差，所以这次把危险的键去掉了。这里只留"多一点少一点不影响事实"的块。
export const SAFE_INJECTION_CAPS = Object.freeze({
  对群友的印象: 900,
  群里的人: 900,
  群里的动静: 1200,
  群聊黑话表: 800,
  可用表情包: 500,
  表情包: 600,
  之前聊的: 600,
  // 谁在对谁说 = 关系/事实的结构化判读，截太狠会让她认错人；给 600（原来是 200）。
  谁在对谁说: 600,
  // 下面几块 2026-10-30 按真实 prompt 统计补的（都曾是单块 800~1000 字）：
  有点不一样: 500,
  他: 800,
  事实: 700,
  你最近: 400,
  '我自己想到的、还没定成经验': 260,
  我最近写下的: 260,
  // 记忆召回块：条目数由 memoryInject.limit 控制，这里只兜住单条过长的长尾。
  你记得的事: 1200,
});

// 合并成**与配额同名的**规范块：mergeBlocks 的 canon title 决定最终标题，
// 两者不一致时配额永远匹配不上（2026-10-28 踩过：合并成「群里的人」而配额写的是「对群友的印象」）。
export const INJECTION_MERGE_GROUPS = Object.freeze([
  { title: '对群友的印象', match: ['对群友的印象', '群友的印象', '这个群里的人', '群里的人'] },
  { title: '你自己', match: ['你自己', '自我档案', '你最近的样子'] },
  { title: '表情包', match: ['表情包策略', '可用表情包', '这轮对得上的表情'] },
]);

// 受管块之外的一律不动：消息/未读/时间/工具协议是"事实"，截断会让她看错。
const PROTECTED_BLOCK = /快照|未读|当前时间|收尾|工具|回复|消息|引用|触发|本轮/;

function truncateBlock(body, cap) {
  const lines = body.split('\n');
  let total = 0;
  const out = [];
  for (const line of lines) {
    if (total + line.length + 1 > cap && out.length > 0) break;
    out.push(line);
    total += line.length + 1;
  }
  const text = out.join('\n');
  if (text.length >= body.length) return body;
  return `${text.replace(/\s+$/, '')}…\n`;
}

/**
 * 注入瘦身：合并同义块 + 白名单块配额（纯函数）。
 * @param {string} text 已拼好的注入文本
 * @param {{caps?:Record<string,number>, mergeGroups?:{title:string,match:string[]}[], hintFor?:(label:string)=>string}} [opts]
 *   hintFor：被截断的块尾部挂一句"完整版在哪查"（来自 prompt-catalog），不传则保持旧行为。
 * @returns {{text:string, before:number, after:number, trimmed:string[]}}
 */
export function compactInjection(text, { caps = SAFE_INJECTION_CAPS, mergeGroups = INJECTION_MERGE_GROUPS, hintFor } = {}) {
  const body = String(text ?? '');
  if (!body) return { text: body, before: 0, after: 0, trimmed: [] };
  const merged = mergeBlocks(body, mergeGroups);
  const marks = [];
  for (const m of merged.matchAll(HEAD_RE)) marks.push({ label: m[1], start: m.index + (m[0].startsWith('\n') ? 1 : 0) });
  if (!marks.length) return { text: merged, before: body.length, after: merged.length, trimmed: [] };

  const parts = [];
  if (marks[0].start > 0) parts.push({ label: null, text: merged.slice(0, marks[0].start) });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : merged.length;
    parts.push({ label: marks[i].label, text: merged.slice(start, end) });
  }

  const trimmed = [];
  const out = parts.map((p) => {
    if (!p.label) return p.text;
    const cap = caps[p.label];
    if (!cap || PROTECTED_BLOCK.test(p.label)) return p.text;
    if (p.text.length <= cap) return p.text;
    trimmed.push(p.label);
    const cut = truncateBlock(p.text, cap);
    // 截断不是终点：能查回来的块在省略号后挂一句入口，别让她以为"就这些了"。
    let hint = '';
    try { hint = typeof hintFor === 'function' ? String(hintFor(p.label) ?? '') : ''; } catch { hint = ''; }
    if (!hint || cut === p.text) return cut;
    return cut.replace(/…\s*$/, `…${hint}\n`);
  });
  const result = out.join('');
  return { text: result, before: body.length, after: result.length, trimmed };
}

// ── 硬预算：注入层超限时按优先级丢块 ─────────────────────────────────────
// 只处理注入层，不碰基底（当前消息/人设/收尾）。先丢“多一点少一点不影响事实”的长尾，
// 保护块（消息/未读/当前时间/收尾/工具/你自己/当前角色）永不主动丢。
export const DROP_ORDER = Object.freeze([
  '群聊黑话表',
  '可用表情包',
  '表情包',
  '对群友的印象',
  '群里的人',
  '之前聊的',
  '有点不一样',
  '我自己想到的、还没定成经验',
  '我最近写下的',
  '你最近',
  '事实',
  '他',
  '谁在对谁说',
  '群里的动静',
  // 记忆是"接得上就接"的参考，最后才丢；但必须可丢，否则群聊预算超限时它会独吞空间。
  '你记得的事',
]);

/**
 * @param {string} text 注入层文本
 * @param {number} maxChars 可用字数
 * @param {{dropOrder?:string[], placeholderFor?:(label:string)=>string}} [opts]
 *   placeholderFor：丢块时若放得下，留一行「【块名】完整版：<工具>」当追回入口
 *   （来自 prompt-catalog）；不传则整块删掉，保持旧行为。
 */
export function enforceInjectionBudget(text, maxChars, { dropOrder = DROP_ORDER, placeholderFor } = {}) {
  const body = String(text ?? '');
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!body) return { text: '', before: 0, after: 0, dropped: [], over: false };
  if (body.length <= limit) return { text: body, before: body.length, after: body.length, dropped: [], over: false };

  const marks = [];
  for (const m of body.matchAll(HEAD_RE)) marks.push({ label: m[1], start: m.index + (m[0].startsWith('\n') ? 1 : 0) });
  if (!marks.length) return { text: body, before: body.length, after: body.length, dropped: [], over: true };

  const parts = [];
  if (marks[0].start > 0) parts.push({ label: null, text: body.slice(0, marks[0].start) });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    parts.push({ label: marks[i].label, text: body.slice(start, end) });
  }

  const dropped = [];
  const placeholders = [];
  let total = body.length;
  const removable = (p) => p.label && !PROTECTED_BLOCK.test(p.label) && !/当前角色|你自己/.test(p.label);
  // 丢一块：放得下就留一行追回入口（【块名】完整版：工具），放不下就整块删掉。
  const dropAt = (idx) => {
    const p = parts[idx];
    const oldLen = p.text.length;
    dropped.push(p.label);
    let line = '';
    try { line = typeof placeholderFor === 'function' ? String(placeholderFor(p.label) ?? '') : ''; } catch { line = ''; }
    if (line) {
      const ph = `【${p.label}】${line}\n\n`;
      if (total - oldLen + ph.length <= limit) {
        parts[idx].text = ph;
        total = total - oldLen + ph.length;
        placeholders.push(p.label);
        return;
      }
    }
    parts.splice(idx, 1);
    total -= oldLen;
  };
  for (const label of dropOrder) {
    if (total <= limit) break;
    const idx = parts.findIndex((p) => removable(p) && p.label.includes(label));
    if (idx >= 0) dropAt(idx);
  }
  // 仍超：从后往前丢剩下的非保护块，直到装下或只剩保护块
  for (let i = parts.length - 1; i >= 0 && total > limit; i -= 1) {
    if (removable(parts[i])) dropAt(i);
  }
  const result = parts.map((p) => p.text).join('');
  return { text: result, before: body.length, after: result.length, dropped, placeholders, over: result.length > limit };
}
