// runtime-metrics.js · 行为指标：让"有没有变好"可测，而不是只看接线通不通
//
// 只用已有数据（social-v2 的 recentMessages/wakeTimes、token-usage.jsonl），不新增采集。
// 指标刻意少而稳：回复延迟、重复率、未读积压、唤醒次数、token/轮。
// 全部纯函数，CLI（scripts/metrics.mjs）和控制台共用。
//
// 注意：recentMessages 有上限（每会话几十条），所以这些是"最近窗口内的近似值"，
// 不能当全量统计；要全量应读 memory/token-usage 的完整日志。

export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

/** 单会话：入站/出站/唤醒、回复延迟、重复率 */
export function conversationMetrics(conv = {}, { now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const rows = (Array.isArray(conv.recentMessages) ? conv.recentMessages : [])
    .filter((m) => m && Number.isFinite(Number(m.time)) && Number(m.time) >= now - windowMs);
  const incoming = rows.filter((m) => !m.isSelf);
  const outgoing = rows.filter((m) => m.isSelf);

  // 回复延迟：每条出站，找它之前 10 分钟内最近的一条入站
  const latencies = [];
  for (const out of outgoing) {
    let best = null;
    for (const inc of incoming) {
      if (Number(inc.time) > Number(out.time)) continue;
      const gap = Number(out.time) - Number(inc.time);
      if (gap <= 10 * 60 * 1000 && (!best || gap < best)) best = gap;
    }
    if (best !== null) latencies.push(best);
  }

  // 重复率：10 分钟内连续两条出站内容相同
  let duplicate = 0;
  for (let i = 1; i < outgoing.length; i += 1) {
    const a = outgoing[i - 1];
    const b = outgoing[i];
    if (Number(b.time) - Number(a.time) > 10 * 60 * 1000) continue;
    if (normalizeText(a.text || a.plain) && normalizeText(a.text || a.plain) === normalizeText(b.text || b.plain)) duplicate += 1;
  }

  const wakeTimes = (Array.isArray(conv.wakeTimes) ? conv.wakeTimes : []).filter((t) => Number(t) >= now - windowMs);
  const lastIncomingAt = incoming.length ? Math.max(...incoming.map((m) => Number(m.time))) : 0;
  const lastReplyAt = outgoing.length ? Math.max(...outgoing.map((m) => Number(m.time))) : 0;
  const unread = Array.isArray(conv.unread) ? conv.unread.length : 0;
  const unansweredMs = lastIncomingAt > lastReplyAt ? now - lastIncomingAt : 0;

  return {
    incoming: incoming.length,
    outgoing: outgoing.length,
    wakes: wakeTimes.length,
    unread,
    unansweredMs,
    lastIncomingAt,
    lastReplyAt,
    replyLatencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), n: latencies.length },
    duplicateSelf: duplicate,
    duplicateRate: outgoing.length > 1 ? Number((duplicate / (outgoing.length - 1)).toFixed(3)) : 0,
  };
}

/** token 用量汇总（token-usage.jsonl 的 turn 记录） */
export function tokenMetrics(rows = [], { now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const turns = (Array.isArray(rows) ? rows : []).filter((r) => r && r.k === 'turn' && Number(r.t) >= now - windowMs);
  let input = 0;
  let hit = 0;
  let output = 0;
  for (const r of turns) {
    const b = r.b || {};
    const miss = Number(b.cacheMiss) || 0;
    const cacheHit = Number(b.cacheHit) || 0;
    const write = Number(b.cacheWrite) || 0;
    input += miss + cacheHit + write;
    hit += cacheHit;
    output += Number(b.output) || 0;
  }
  return {
    turns: turns.length,
    inputTokens: input,
    outputTokens: output,
    cacheHitRate: input ? Number((hit / input).toFixed(3)) : null,
    avgInputPerTurn: turns.length ? Math.round(input / turns.length) : 0,
    avgOutputPerTurn: turns.length ? Math.round(output / turns.length) : 0,
  };
}

/** 全量汇总 + 状态一致性告警（能看出"三份真相"打架的地方） */
export function computeMetrics({ conversations = new Map(), tokenRows = [], now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const perConversation = [];
  const warnings = [];
  for (const [key, conv] of conversations) {
    const m = conversationMetrics(conv, { now, windowMs });
    perConversation.push({ key, ...m });
    const lastUnread = Number(conv?.lastUnreadSeq) || 0;
    const readThrough = Number(conv?.lastReadThroughSeq) || 0;
    if (lastUnread > 0 && readThrough > lastUnread + 0) {
      warnings.push(`${key}: lastReadThroughSeq(${readThrough}) 超过了 lastUnreadSeq(${lastUnread})`);
    }
    const badUnread = (Array.isArray(conv?.unread) ? conv.unread : []).filter((msg) => Number(msg?.seq) > 0 && Number(msg.seq) <= readThrough);
    if (badUnread.length) warnings.push(`${key}: 未读队列里有 ${badUnread.length} 条 seq ≤ 已读水位（状态不一致）`);
    if (m.unread > 0 && m.unansweredMs > 30 * 60 * 1000) {
      warnings.push(`${key}: 未读 ${m.unread} 条，已 ${Math.round(m.unansweredMs / 60000)} 分钟没人回`);
    }
    if (m.wakes > 0 && m.incoming === 0 && m.unread === 0) {
      warnings.push(`${key}: 24h 内唤醒 ${m.wakes} 次、零入站（可能是空转唤醒，查 [IDLE-SNAPSHOT] 与主动检查）`);
    }
    // 唤醒效率：叫醒很多次却几乎不开口（群 123456789 实测 200 次/3 句）
    if (m.wakes >= 20 && m.outgoing / m.wakes < 0.1) {
      warnings.push(`${key}: 唤醒 ${m.wakes} 次只出口 ${m.outgoing} 次（唤醒空转，查门判/潜水概率/群窗）`);
    }
  }

  const totals = perConversation.reduce((acc, c) => ({
    incoming: acc.incoming + c.incoming,
    outgoing: acc.outgoing + c.outgoing,
    wakes: acc.wakes + c.wakes,
    unread: acc.unread + c.unread,
    duplicateSelf: acc.duplicateSelf + c.duplicateSelf,
  }), { incoming: 0, outgoing: 0, wakes: 0, unread: 0, duplicateSelf: 0 });

  const tokens = tokenMetrics(tokenRows, { now, windowMs });
  // 上下文健康：单轮输入长期贴着模型上限，说明历史/工具 schema 在膨胀。
  if (tokens.avgInputPerTurn > 80_000) {
    warnings.push(`平均每步输入 ${tokens.avgInputPerTurn} token（>80k）：上下文接近上限，查历史累积与工具 schema 体积`);
  }
  return {
    windowHours: Math.round(windowMs / 3600000),
    at: new Date(now).toISOString(),
    totals: {
      ...totals,
      duplicateRate: totals.outgoing > 1 ? Number((totals.duplicateSelf / (totals.outgoing - 1)).toFixed(3)) : 0,
      conversations: perConversation.length,
    },
    tokens,
    perConversation: perConversation.sort((a, b) => b.outgoing - a.outgoing),
    warnings,
  };
}
