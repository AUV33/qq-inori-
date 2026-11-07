// scaffold-meter.mjs · 宪章 §5.7 / G1：脚手架撤离的可度量门禁（纯函数）
//
// 干什么：统计系统注入文本里的"指令性/许可性"话语——"你可以…""建议…""请…""记得…"。
//         这不是为了审查她的表达，而是为了量"系统还在替她做多少决定"。
// 为什么：§5.7 说"指令性 token 周环比必须单调下降"，但没有度量就没有门禁；
//         没有门禁的 KPI 会在下一次功能迭代里悄悄回升（G1）。
// 输入输出：纯函数；meter(text) → 字符数/指令性字符数/占比/命中明细；aggregate/trend 做周报。
// 失败模式：空文本返回零值；超长文本只统计命中区间，不抛错。
// 不做什么：不判断语义对错、不改写 prompt、不读盘、不写盘。
//
// 口径（写死，避免每周换尺子）：
//   · chars = 非空白字符数（中文按字，英文按字符）
//   · imperativeChars = 命中短语覆盖的字符并集（重叠只算一次）
//   · ratio = imperativeChars / chars
//   · 周环比下降是"好"（撤离方向），上升只报警、不自动拦截。

export const SCAFFOLD_METER_VERSION = 1;

/** 短语表：保守、可解释；宁可少报，也不把普通陈述误判成指令。 */
export const SCAFFOLD_PHRASES = Object.freeze([
  // 许可句：把她当"需要被允许"的人
  { category: 'permission', phrase: '【你现在可以】' },
  { category: 'permission', phrase: '你现在可以' },
  { category: 'permission', phrase: '你可以选择' },
  { category: 'permission', phrase: '你可以考虑' },
  { category: 'permission', phrase: '你可以先' },
  { category: 'permission', phrase: '你可以' },
  { category: 'permission', phrase: '你可以试试' },
  { category: 'permission', phrase: '不妨' },
  { category: 'permission', phrase: '要不要' },
  { category: 'permission', phrase: '想不想' },
  // 建议句：系统替她设定"更优选项"
  { category: 'advice', phrase: '建议你' },
  { category: 'advice', phrase: '建议' },
  { category: 'advice', phrase: '应该' },
  { category: 'advice', phrase: '最好' },
  { category: 'advice', phrase: '试试' },
  { category: 'advice', phrase: '记得' },
  { category: 'advice', phrase: '别忘了' },
  // 命令/催促句
  { category: 'command', phrase: '请你' },
  { category: 'command', phrase: '请先' },
  { category: 'command', phrase: '请' },
  { category: 'command', phrase: '必须' },
  { category: 'command', phrase: '需要你' },
  { category: 'command', phrase: '你要' },
  { category: 'command', phrase: '务必' },
  { category: 'command', phrase: '现在去' },
  { category: 'command', phrase: '去做' },
  // 提醒句
  { category: 'reminder', phrase: '提醒你' },
  { category: 'reminder', phrase: '不要忘记' },
  { category: 'reminder', phrase: '别忘' },
]);

const MAX_HITS = 300;

function countChars(text) {
  let n = 0;
  for (const ch of String(text ?? '')) if (!/\s/.test(ch)) n += 1;
  return n;
}

/**
 * @param {string} text
 * @returns {{v:number, chars:number, imperativeChars:number, ratio:number,
 *            hits:{category:string, phrase:string, index:number, length:number}[],
 *            byCategory:Record<string,number>}}
 */
export function meter(text) {
  const source = String(text ?? '');
  const chars = countChars(source);
  const covered = new Uint8Array(source.length);
  const hits = [];
  const byCategory = { permission: 0, advice: 0, command: 0, reminder: 0 };
  for (const { category, phrase } of SCAFFOLD_PHRASES) {
    let from = 0;
    for (;;) {
      const index = source.indexOf(phrase, from);
      if (index < 0) break;
      hits.push({ category, phrase, index, length: phrase.length });
      byCategory[category] = (byCategory[category] || 0) + 1;
      for (let i = index; i < index + phrase.length && i < covered.length; i += 1) covered[i] = 1;
      from = index + Math.max(1, phrase.length);
      if (hits.length >= MAX_HITS) break;
    }
    if (hits.length >= MAX_HITS) break;
  }
  let imperativeChars = 0;
  for (let i = 0; i < covered.length; i += 1) if (covered[i]) imperativeChars += 1;
  const ratio = chars > 0 ? Number((imperativeChars / chars).toFixed(4)) : 0;
  return { v: SCAFFOLD_METER_VERSION, chars, imperativeChars, ratio, hits, byCategory };
}

/** 多份 prompt 的周汇总（按字符加权，不是简单平均）。 */
export function aggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let chars = 0;
  let imperativeChars = 0;
  const byCategory = { permission: 0, advice: 0, command: 0, reminder: 0 };
  for (const row of list) {
    chars += Number(row?.chars) || 0;
    imperativeChars += Number(row?.imperativeChars) || 0;
    for (const key of Object.keys(byCategory)) byCategory[key] += Number(row?.byCategory?.[key]) || 0;
  }
  return {
    samples: list.length,
    chars,
    imperativeChars,
    ratio: chars > 0 ? Number((imperativeChars / chars).toFixed(4)) : 0,
    byCategory,
  };
}

/** 周环比：ratio 下降 = 撤离有进展；上升只报告，不自动拦截。 */
export function trend(current, previous) {
  const cur = current && typeof current === 'object' ? current : aggregate([]);
  const prev = previous && typeof previous === 'object' ? previous : aggregate([]);
  const curRatio = Number(cur.ratio) || 0;
  const prevRatio = Number(prev.ratio) || 0;
  const delta = Number((curRatio - prevRatio).toFixed(4));
  const percent = prevRatio > 0 ? Number(((delta / prevRatio) * 100).toFixed(1)) : (curRatio > 0 ? 100 : 0);
  return {
    current: curRatio, previous: prevRatio, delta, percent,
    direction: delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat',
    improved: delta < 0,
  };
}
