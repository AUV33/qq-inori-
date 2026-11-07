// 独处时的自主决策：只做选择，不执行 IO，便于测试和替换策略。
const ageMs = (value, now) => {
  const at = Date.parse(value ?? '') || 0;
  return at ? Math.max(0, now - at) : Infinity;
};

export function chooseAction(input = {}) {
  const now = Number(input.now) || Date.now();
  const goals = (input.goals ?? []).filter((g) => g?.status === 'active');
  const messages = (input.recentMessages ?? []).filter((m) => m && !m.isSelf && String(m.text ?? '').trim());
  const lessons = (input.lessons ?? []).filter((x) => x && String(x.text ?? '').trim());
  const relation = input.relationship ?? {};
  const staleGoal = goals.slice().sort((a, b) => ageMs(b.touchedAt, now) - ageMs(a.touchedAt, now))[0];

  // ① 掉地上的"想要"（之前想独处但连着忙，机会被放弃了）：先接住它。
  //    这是她自己的愿望，不是系统安排——语气是"补上"，不是"执行"。
  if (input.pendingWish && Number(input.pendingWish.count) > 0) {
    const wishLines = goals.length
      ? `\n你"想做"的事（${goals.length} 件）：\n${goals.slice(0, 5).map((g, i) => `  ${i + 1}. ${String(g.text).slice(0, 60)}`).join('\n')}`
      : '';
    return {
      kind: 'wish-makeup',
      reason: '之前想独处但连着太忙没去成，现在是空档',
      prompt: `你之前想自己待会儿，连着 ${input.pendingWish.count} 次都没去成（那时候正忙）。现在是你的空档——这次补上：${wishLines}\n想做哪件挑哪件（最小的一步就行，做完 goal_progress 记一笔）；一件都不想，就发条说说、写句日记，或者就坐着什么都不干。别为了"做点什么"而硬做。`,
    };
  }

  // ①.5 她自己挂心着的事（open loops）：空档里正好可以去弄明白。
  //     这是她自己挂的，不是系统派的；查不查、放不放下都随她。空容器整块不出现。
  const loops = (input.curiosityLoops ?? []).filter((l) => l && String(l.text ?? "").trim());
  if (loops.length) {
    const top = loops[0];
    const more = loops.slice(1, 4).map((x) => `「${String(x.text).slice(0, 40)}」`).join("、");
    const src = String(top.source ?? "").trim();
    return {
      kind: "curiosity-chase",
      reason: "你自己挂心着的事还没弄明白",
      prompt: `你之前挂心着：「${String(top.text).slice(0, 80)}」${src ? `（来自${src}）` : ""}。现在没人找你——想弄清就去查（web_search / web_fetch；想看视频就 video_feed / video_watch），查到想知道的就在 qq_curiosity forget 关掉它；不想管了也一样，关掉或放着都行。`
        + (more ? `\n另外还挂着：${more}。` : "")
        + "\n不是任务，查不查随你；要是这会儿更想做别的，做别的也行。",
    };
  }
  // ② 有想做的事：全给她看，她挑（不再系统指派"优先推进 X"）
  if (staleGoal && ageMs(staleGoal.touchedAt, now) >= 6 * 3600 * 1000) {
    const goalLines = goals.slice(0, 5).map((g, i) => `  ${i + 1}. ${String(g.text).slice(0, 60)}${g.nextAction ? `（下一步：${String(g.nextAction).slice(0, 50)}）` : ''}`).join('\n');
    const note = goals.length ? `\n你"想做"的事（${goals.length} 件）：\n${goalLines}\n挑一件做（最小的一步就行），做完 goal_progress 记一笔 + 下一步、完成了 goal_done（要写 evidence：凭什么算做完）；一件都不想，就发条说说、写句日记，或者什么都不干。` : '';
    return {
      kind: 'goal-progress',
      reason: '有一件目标已经较久没有推进',
      prompt: `${note}\n（第 ${goals.indexOf(staleGoal) + 1} 件「${String(staleGoal.text).slice(0, 50)}」挺久没动了，要是做它，就先做最小的一步。）`,
    };
  }
  const recentRelation = messages.filter((m) => m.isOwner || m.owner || m.sender || m.userId);
  if (recentRelation.length && (relation.recentFacts > 0 || recentRelation.length >= 2)) {
    const last = recentRelation[recentRelation.length - 1];
    return { kind: 'relationship-reflection', reason: '最近有互动，先整理可复用的关系事实', prompt: `回看最近互动：${String(last.text).slice(0, 160)}。只有在事实稳定、以后确实有用时，才用 qq_memory_append 记一条；一次情绪不要当长期结论。` };
  }
  if (messages.length && !lessons.length) {
    return { kind: 'learning-review', reason: '最近有对话但还没有形成经验', prompt: '回看最近对话：有没有一条关于“你自己如何做事/回应”的可复用经验？没有就不记录，不要为了学习而硬写。' };
  }
  return { kind: 'creative-rest', reason: '当前没有需要强推的事项', prompt: '现在可以自由写一句日记、看看旧经验，或者什么都不做。自主时间不要求产出。' };
}

export function buildAutonomyPrompt(input = {}) {
  const action = chooseAction(input);
  return `【自主时间｜${action.kind}】${action.prompt}\n选择理由：${action.reason}`;
}

export default chooseAction;
