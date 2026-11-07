// 关系上下文聚合。调用方必须先按会话 scope 过滤输入，本模块不会跨库读取。
// [PROMPT-SLIM] 2026-10-30：原来 6 条事实 ×200 字 + 5 条互动 ×160 字，单块能到 1200+ 字，
// 群里每轮都在烧这段。关系是"参考"不是"事实"，收窄到 3×80 / 3×60——认得出这个群就够。
const textOf = (x) => String(x?.text ?? x?.plain ?? '').trim();

export function summarizeRelationship({
  messages = [], memories = [], scope = 'private', now = Date.now(),
  maxFacts = 3, factChars = 80, maxRecent = 3, recentChars = 60,
} = {}) {
  const safeMessages = messages.filter((m) => m && !m.isSelf && textOf(m));
  const safeMemories = memories.filter((m) => m && textOf(m) && (!m.scope || m.scope === scope));
  const recent = safeMessages.slice(-Math.max(1, maxRecent)).map((m) => ({ sender: String(m.sender ?? m.userId ?? '未知'), text: textOf(m).slice(0, Math.max(20, recentChars)), time: Number(m.time) || now, isOwner: !!m.isOwner }));
  const facts = safeMemories.slice().sort((a, b) => String(b.time ?? b.at ?? '').localeCompare(String(a.time ?? a.at ?? ''))).slice(0, Math.max(1, maxFacts));
  return { scope, interactionCount: safeMessages.length, recentFacts: facts.length, lastInteractionAt: recent.length ? recent[recent.length - 1].time : 0, recent, facts: facts.map((m) => textOf(m).slice(0, Math.max(20, factChars))) };
}

export function renderRelationship(summary) {
  if (!summary || (!summary.recent?.length && !summary.facts?.length)) return '';
  const lines = ['最近关系上下文（仅限当前会话，事实和推测要分开）：'];
  for (const fact of summary.facts ?? []) lines.push(`- 已记录事实：${fact}`);
  for (const item of summary.recent ?? []) lines.push(`- 最近互动（${item.sender}）：${item.text}`);
  return lines.join('\n');
}

export default summarizeRelationship;
