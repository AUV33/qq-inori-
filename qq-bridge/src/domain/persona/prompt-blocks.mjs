// prompt-blocks.mjs · 提示词装配的声明式块（P2 的第一步）
//
// 目标（见 docs/internal/_archive/架构/架构-目标架构-20261103.md）：把 wake-prompt 里"按代码顺序
// 拼字符串"的写法，逐步收敛成"块表 + 装配器"：每个块有 id、层（tier）、条件、文本。
// 装配器只做三件事：按声明顺序过滤条件、拼接、产出可计量的块统计。
//
// 设计约束：
//   · 纯函数，不读文件、不碰时间、不 log（调用方拿 stats 自己记）；
//   · 兼容过渡期：块可以是字符串（老写法）或 {id, tier, text, when}；
//   · 输出与"直接 join"逐字节一致——迁移期用它不该改变任何提示词。

/** 把各种形态的块归一成 {id, tier, text, when} */
function normalize(block, index, fallbackTier = 'ref') {
  if (typeof block === 'string') return { id: `anon-${index}`, tier: fallbackTier, text: block, when: true };
  return {
    id: String(block?.id ?? `anon-${index}`),
    tier: String(block?.tier ?? fallbackTier),
    text: String(block?.text ?? ''),
    when: block?.when ?? true,
  };
}

/**
 * 装配块表。
 * @param {Array<string|{id?:string,tier?:string,text?:string,when?:boolean|(()=>boolean)}>} blocks
 * @param {{ctx?:any}} [options] when 为函数时传入的上下文
 * @returns {{text:string, total:number, blocks:Array<{id:string,tier:string,chars:number}>, skipped:string[]}}
 */
export function assembleBlocks(blocks, options = {}) {
  const fallbackTier = String(options.tier ?? 'ref');
  const list = Array.isArray(blocks) ? blocks : [];
  const kept = [];
  const skipped = [];
  let text = '';
  list.forEach((raw, index) => {
    const b = normalize(raw, index, fallbackTier);
    const ok = typeof b.when === 'function' ? !!b.when(options.ctx) : b.when !== false;
    if (!ok) { skipped.push(b.id); return; }
    if (!b.text) return;
    text += b.text;
    kept.push({ id: b.id, tier: b.tier, chars: b.text.length });
  });
  return { text, total: text.length, blocks: kept, skipped };
}

/** 按层汇总字数（给预算/日志用） */
export function sumByTier(result) {
  const out = {};
  for (const b of result?.blocks ?? []) out[b.tier] = (out[b.tier] ?? 0) + b.chars;
  return out;
}
