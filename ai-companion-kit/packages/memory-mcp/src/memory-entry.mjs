// memory-entry.mjs · 情景记忆条目构造（F2 provenance，M3 可溯源）
//
// 纯函数、无重型依赖、可单测。构造时即补上 provenance：
//   · recordedAt  —— 落盘时刻（ISO），便于遗忘/审计
//   · src         —— 来源（private / group_<id>），区分"谁处来的记忆"
//   · embedModel  —— 生成嵌入所用的模型@维度，配合 embed-key 做版本化
// 老条目缺这些字段也能正常读（读取侧已对缺失字段做容错）。
export function today(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${today(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const CLAIM_RE = [
  [/承诺|答应|说好|约好|保证/, 'promise'],
  [/吵架|吵了|骂|生气|翻脸/, 'conflict'],
  [/喜欢|讨厌|最爱|想吃/, 'preference'],
  [/打算|计划|准备/, 'plan'],
];

export function claimTypeOf(text) {
  for (const [re, t] of CLAIM_RE) if (re.test(String(text ?? ''))) return t;
  return '';
}

export function buildMemoryEntry({ text, kind, who, felt, theme, scope, now = new Date(), embedModel = 'bge-m3@1024', pinned = false, occurredOn = '', pinReason = '' }) {
  const entry = {
    day: today(now),
    time: stamp(now),
    kind: kind ?? 'event',
    text,
    mentions: 1,
    lastMentionAt: now.getTime(),
    // [F2-PROVENANCE]
    recordedAt: now.toISOString(),
    src: scope,
    embedModel,
  };
  const w = String(who ?? '').trim();
  const f = String(felt ?? '').trim();
  const t = String(theme ?? '').trim();
  if (w) entry.who = w.slice(0, 20);
  if (f) entry.felt = f.slice(0, 60);
  if (t) entry.theme = t.slice(0, 20);
  const claimType = claimTypeOf(text);
  if (claimType) entry.claimType = claimType;
  // [SEMANTIC-PIN] 只有显式传入才写字段，旧条目形状不变。
  if (pinned) entry.pinned = true;
  if (occurredOn) entry.occurredOn = String(occurredOn).slice(0, 10);
  if (pinReason) entry.pinReason = String(pinReason).slice(0, 24);
  return entry;
}
