// semantic-pin.mjs · 宪章 §5.11：语义钉 vs 情景流（T1 时间解耦）
//
// 干什么：写入记忆前判断"这条该不该永久钉住"：
//   · owner 的稳定事实/偏好（我喜欢…/我住在…/我生日…）→ semantic 钉（pinned=true, kind=fact）；
//   · 一次性事件（今天吃了披萨/昨天去了…）→ episodic 流（kind=episode, 带绝对日期）；
//   · 相对时间词（今天/昨天/去年…）换算成绝对 occurredOn，避免"去年说今天"被当成当前事实。
// 为什么：memory-retention 只保护"已经标成 fact/pinned"的条目；如果写入时不分类，
//   一次性闲聊会被当普通事件衰减，owner 事实也可能被 2000 条上限挤掉。
// 输入输出：纯函数；classifyMemory()/absolutizeTemporal()/describeOccurredOn()。
// 失败模式：无法判断时返回 episodic（保守，不误钉）；解析不出时间返回空 occurredOn。
// 不做什么：不写盘、不改记忆条目、不做语义压缩（S7c）。

// [PROMPT-SAFETY] occurredOn 也可能来自外部文本；展示前中性化。
import { sanitizePromptSnippet } from '../shared/prompt-safety.mjs';

export const SEMANTIC_PIN_VERSION = 1;

const DAY_MS = 86400000;
const EXPLICIT_DATE = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/;

function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对时间词 → 日期。返回 {occurredOn, precision, refs}；多个时取第一个（最靠近事件主句）。 */
export function absolutizeTemporal(text, { now = Date.now() } = {}) {
  const source = String(text ?? '');
  const base = new Date(Number(now) || Date.now());
  const refs = [];
  const explicit = EXPLICIT_DATE.exec(source);
  if (explicit) {
    const y = Number(explicit[1]); const m = Number(explicit[2]); const day = Number(explicit[3]);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      refs.push({ word: explicit[0], kind: 'explicit' });
      return { occurredOn: localIso(new Date(y, m - 1, day)), precision: 'day', refs };
    }
  }
  const dayWords = [
    ['大前天', -3], ['前天', -2], ['昨天', -1], ['今天', 0], ['明天', 1], ['后天', 2], ['大后天', 3],
  ];
  const yearWords = [['前年', -2], ['去年', -1], ['今年', 0], ['明年', 1]];
  // 同一个句子可能有多个时间词（「去年我说今天吃了披萨」）：取**最靠前**的那个，
  // 否则会把「去年的事」错记成「今天」。
  const candidates = [];
  for (const [word, delta] of dayWords) {
    const index = source.indexOf(word);
    if (index >= 0) candidates.push({ index, word, kind: 'day', delta });
  }
  for (const [word, delta] of yearWords) {
    const index = source.indexOf(word);
    if (index >= 0) candidates.push({ index, word, kind: 'year', delta });
  }
  candidates.sort((a, b) => a.index - b.index || b.word.length - a.word.length);
  const first = candidates[0];
  if (!first) return { occurredOn: '', precision: 'none', refs };
  refs.push({ word: first.word, kind: first.kind, delta: first.delta });
  if (first.kind === 'day') return { occurredOn: localIso(new Date(base.getTime() + first.delta * DAY_MS)), precision: 'day', refs };
  return { occurredOn: String(base.getFullYear() + first.delta), precision: 'year', refs };
}

const OWNER_FACT_RE = /^我(?:的|是|叫|住|在|喜欢|爱|讨厌|想|要|有|养|生日|工作|上班|上学|学|最近|今年|明年)/;
const STABLE_FACT_RE = /(喜欢|讨厌|最爱|生日|住在|名字叫|工作是|学校是|习惯|过敏|不吃|不能吃)/;
const EPISODE_RE = /(吃了|去了|看了|玩了|买了|见了|聊了|做了|梦到|发生)/;

/**
 * @param {{text:string, kind?:string, isOwner?:boolean, now?:number}} input
 * @returns {{kind:'fact'|'episode', pinned:boolean, occurredOn:string, precision:string, reason:string, refs:Array}}
 */
export function classifyMemory({ text, kind = '', isOwner = false, now = Date.now() } = {}) {
  const body = String(text ?? '').trim();
  const temporal = absolutizeTemporal(body, { now });
  if (!body) return { kind: 'episode', pinned: false, occurredOn: '', precision: 'none', reason: 'empty', refs: [] };

  if (kind === 'fact') return { kind: 'fact', pinned: true, occurredOn: temporal.occurredOn, precision: temporal.precision, reason: 'explicit-fact', refs: temporal.refs };

  const ownerFact = isOwner && OWNER_FACT_RE.test(body);
  const stableFact = STABLE_FACT_RE.test(body);
  const episode = EPISODE_RE.test(body);

  // 稳定事实优先于"今天"这类时间词：今天说自己喜欢什么，钉的是偏好，不是当天事件。
  if (ownerFact || (stableFact && !episode)) {
    return { kind: 'fact', pinned: true, occurredOn: temporal.occurredOn, precision: temporal.precision, reason: ownerFact ? 'owner-fact' : 'stable-fact', refs: temporal.refs };
  }
  return {
    kind: 'episode', pinned: false,
    occurredOn: temporal.occurredOn, precision: temporal.precision,
    reason: temporal.refs.length ? 'dated-episode' : 'episode',
    refs: temporal.refs,
  };
}

/** 检索展示：把绝对日期带给未来的她，避免把"当时今天"当成"现在"。 */
export function describeOccurredOn(entry) {
  const value = sanitizePromptSnippet(entry?.occurredOn, { maxChars: 12 });
  if (!value) return '';
  return `（发生：${value}）`;
}
