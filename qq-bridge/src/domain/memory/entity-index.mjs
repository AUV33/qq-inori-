// entity-index.mjs · 宪章 §5.12/G11：实体索引（不依赖外部 dsh-mneme）
//
// 干什么：用一份“已知实体名 → 实体 id”表，从文本里找出被提到的实体；给联想图提供
//   “共同提到的人/物”边，补上 who/theme 之外的联系。
// 为什么：仓库里没有 dsh-mneme 的实体图；先做一个确定性、可解释的轻量实体索引，
//   让“同一个人/同一件事”的共提也能参与扩散，而不是只看字段相等。
// 输入输出：纯函数；名字表进，extractor/mentions 出；不读盘、不调模型。
// 失败模式：空表/空文本返回空；名字长度 <2 忽略（避免单字噪声）。
// 不做什么：不做 NER/消歧/指代消解；“同一个名字”只按精确子串匹配，宁可少认。

export const ENTITY_INDEX_VERSION = 1;

const clean = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/**
 * @param {Array<string|{name:string,id?:string}>} names
 * @returns {{v:number, names:Array<{name:string,id:string}>, index:Map<string,string>}}
 */
export function buildEntityIndex(names) {
  const rows = [];
  const index = new Map();
  for (const item of Array.isArray(names) ? names : []) {
    const name = clean(typeof item === 'string' ? item : item?.name);
    const id = clean(typeof item === 'string' ? item : item?.id) || name;
    if (!name || [...name].length < 2) continue;
    if (index.has(name.toLowerCase())) continue;
    index.set(name.toLowerCase(), id);
    rows.push({ name, id });
  }
  rows.sort((a, b) => [...b.name].length - [...a.name].length);
  return { v: ENTITY_INDEX_VERSION, names: rows, index };
}

/** 从文本提取实体 id（最长优先，命中后遮住该段，避免重叠重复）。 */
export function extractMentions(text, entityIndex, { max = 6 } = {}) {
  let s = clean(text).toLowerCase();
  if (!s) return [];
  const out = [];
  for (const row of entityIndex?.names || []) {
    if (out.length >= max) break;
    const needle = row.name.toLowerCase();
    if (!needle || !s.includes(needle)) continue;
    out.push(row.id);
    s = s.split(needle).join(' '.repeat(needle.length));
  }
  return [...new Set(out)];
}

/** 返回一个 entityOf(entry) 闭包，供联想图使用。 */
export function createEntityExtractor(entityIndex, { key = (e) => e?.text } = {}) {
  return (entry) => {
    const text = typeof key === 'function' ? key(entry) : entry?.text;
    return extractMentions(text, entityIndex);
  };
}

/** 两个实体集合的共同度：交集 / 较小集合；空集为 0。 */
export function sharedEntityWeight(a, b) {
  const A = new Set(Array.isArray(a) ? a.filter(Boolean) : []);
  const B = new Set(Array.isArray(b) ? b.filter(Boolean) : []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const id of A) if (B.has(id)) inter += 1;
  if (!inter) return 0;
  return inter / Math.min(A.size, B.size);
}
