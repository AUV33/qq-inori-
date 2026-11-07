// inori-facts.js · 「关于他」的事实自动提炼（确定性规则，不花模型钱）
//
// 为什么需要：她很少主动调 memory_save（历史 0 次），事实层只有 6 条，
// 长期记忆靠每日 digest 批量写，粒度太粗。这里在主人私聊里用规则抓稳定事实，
// 去重后写进 data/memory/memory.jsonl，让「关于他」的档案自己变厚。
//
// 原则：
// - 只转写、不发挥：事实文本尽量保留原句里的关键片段（用「」引用）。
// - 只针对稳定事实（生日/喜好/习惯/住处/称谓/关系/雷区），不抓情绪与临时事。

const PATTERNS = [
  { kind: 'birthday', re: /(?:我)?(?:的)?生日(?:是|在|是)?\s*([0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号]|[0-9]{4}[-/年][0-9]{1,2}[-/月][0-9]{1,2}|下周[一二三四五六日天]|明天|今天)/ },
  { kind: 'age', re: /我\s*(?:今年)?\s*([0-9]{1,2})\s*岁/ },
  { kind: 'like', re: /我\s*(?:很|最|超|特别|非常|挺|蛮|真的)?\s*(?:喜欢|爱|迷上|中意)\s*([^，。！？,.!?\n]{1,24})/ },
  { kind: 'dislike', re: /我\s*(?:很|最|超|特别|非常|挺|真的)?\s*(?:讨厌|不喜欢|受不了|烦)\s*([^，。！？,.!?\n]{1,24})/ },
  { kind: 'habit', re: /我\s*(?:每天|总是|经常|一般|习惯|通常)\s*([^，。！？,.!?\n]{2,30})/ },
  { kind: 'live', re: /我\s*(?:住在|家在)\s*([^，。！？,.!?\n]{2,20})/ },
  { kind: 'live', re: /我\s*在\s*([^，。！？,.!?\n]{2,20})(?:工作|上班|上学|读书)/ },
  { kind: 'name', re: /(?:你)?(?:可以)?叫我\s*([^，。！？,.!?\n]{1,12})/ },
  { kind: 'name', re: /我(?:的名字)?叫\s*([^，。！？,.!?\n]{1,12})/ },
  { kind: 'relation', re: /我(?:老婆|老公|女朋友|男朋友|儿子|女儿|爸|妈|哥|姐|弟|妹)([^，。！？,.!?\n]{0,16})/ },
  { kind: 'boundary', re: /(?:别|不要)\s*(?:跟我)?(?:说|提|问)\s*([^，。！？,.!?\n]{1,24})/ },
  // 2026-10 扩充：工具/拥有/忌口/打算/当前在做/爱好——私聊库太薄（6 行），确定性扩写面
  { kind: 'tool', re: /我(?:平时用|玩(?:的|机|手柄)?|用)\s*(?:的?是?)?\s*([^，。！？,.!?\n]{1,16})/ },
  { kind: 'possess', re: /我(?:养了?|有|家里?有)\s*([^，。！？,.!?\n]{1,14})/ },
  { kind: 'tabo', re: /我不([吃喝玩用运动看])([^，。！？,.!?\n]{0,10})/ },
  { kind: 'wish', re: /我(?:打算|准备|想去|想学|想做|想试)\s*([^，。！？,.!?\n]{1,14})/ },
  { kind: 'doing', re: /我在((?:上)班|上学|加班|读书|实习)/ },
  { kind: 'hobby', re: /我(?:的)?爱好(?:是)?\s*([^，。！？,.!?\n]{1,16})/ },
];

const STOP = new Set(['什么', '这个', '那个', '东西', '事情', '一下', '一点', '有点', '真的', '就是', '不是', '空', '钱', '点', '事', '时间', '想法']);

/** 从一条消息里抽事实 */
export function extractFacts(text) {
  const src = String(text || '').replace(/\[[^\]]{0,16}\]/g, '').trim();
  if (!src || src.length > 200) return [];
  const out = [];
  const seen = new Set();
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(src);
    if (!m) continue;
    const value = (kind === 'tabo' ? String(m[1]) + (m[2] || '') : String(m[1] || '')).trim();
    if (!value || STOP.has(value)) continue;
    // 误捕拦截：「我有空了再回」「我有事」这类日常用语不是事实
    if (kind === 'possess' && /^(空|事|钱|点|时间|想法|事做)/.test(value)) continue;
    const key = kind + '|' + value;
    if (seen.has(key)) continue;
    seen.add(key);
    const valueClean = value.replace(/\s+/g, ' ').slice(0, 40);
    const map = {
      birthday: `他的生日是「${valueClean}」`,
      age: `他今年 ${valueClean} 岁`,
      like: `他喜欢「${valueClean}」`,
      dislike: `他讨厌「${valueClean}」`,
      habit: `他习惯「${valueClean}」`,
      live: `他住在/在「${valueClean}」`,
      name: `可以叫他「${valueClean}」`,
      relation: `他的家人/伴侣「${valueClean}」`,
      boundary: `别提「${valueClean}」（他不喜欢）`,
      tool: `他常用「${valueClean}」`,
      possess: `他家里有/养了「${valueClean}」`,
      tabo: `他不${valueClean}`,
      wish: `他打算「${valueClean}」`,
      doing: `他目前在「${valueClean}」`,
      hobby: `他的爱好是「${valueClean}」`,
    };
    out.push({ kind, text: sanitizeFact(map[kind] || `他说「${valueClean}」`), evidence: src.slice(0, 80) });
  }
  return out;
}

/** 二元组相似度（去重/判重） */
export function similarity(a, b) {
  const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A), gb = grams(B);
  if (!ga.size || !gb.size) return A === B ? 1 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** 候选事实去重（对比已有文本） */
export function dedupeFacts(candidates, existingTexts, threshold = 0.6) {
  const kept = [];
  for (const c of candidates) {
    if (existingTexts.some((t) => similarity(t, c.text) >= threshold)) continue;
    if (kept.some((k) => similarity(k.text, c.text) >= threshold)) continue;
    kept.push(c);
  }
  return kept;
}

/** [脱敏] 确定性脱敏：号码/账号/密码绝不进记忆库（2026-10-23 私聊出现过账号密码，用户要求硬保护）。
 *  事实行与 digest / 群记忆行写入前统一过一遍。 */
export function sanitizeFact(text) {
  let t = String(text ?? '');
  t = t.replace(/1[0-9]{10}/g, '[号码]');
  t = t.replace(/(账号|帐号|账户)\s*(?:是|为)?\s*[:：]?\s*\d{5,16}/g, '账号[已隐藏]');
  t = t.replace(/(密码|passwd|pwd)\s*(?:是|为)?\s*[:：]?\s*[^「」\s]{2,20}/gi, '[已隐藏]');
  return t;
}
