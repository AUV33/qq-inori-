// engagement-metrics.mjs · 漏接率/三分类：该回的直接对话，她有没有真的回（纯函数）
//
// 干什么：把 floor-decisions（门判定）与 action-log（回合结果）对齐，
//         对 directed+wake 的行，按窗口内是否遇到 sent / 其它 turn / 没有 turn 分类。
// 为什么：只算 missed 会把“忙/有意不回”和“真没回合”混在一起，阈值会失真。
// 输入输出：纯函数；两组日志行进，计数与比率出。
// 失败模式：时间解析失败的行跳过；无样本 noData=true。
// 不做什么：不读文件、不调用模型；只做时间窗对齐。

export const ENGAGEMENT_METRICS_VERSION = 1;

function tsOf(row, keys = ['at', 'ts', 'time']) {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return 0;
}

/**
 * 三分类：directed+wake 的行在窗口内分别遇到 sent / 其它 turn / 完全没有 turn。
 * “没有 turn”才接近真漏接；“turn 但 no_action”算有意不回。
 */
export function classifyDirected(floorRows, actionRows, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 5 * 60 * 1000;
  // [LOOKBACK] floor 行常在回合开始后才落盘（实测只差 5ms），只看“行之后”会把已发生的 sent 误判成没回合。
  const lookbackMs = Number.isFinite(opts.lookbackMs) && opts.lookbackMs >= 0 ? opts.lookbackMs : 30 * 1000;
  const floors = (Array.isArray(floorRows) ? floorRows : []).filter((r) => r && typeof r === 'object');
  const turns = (Array.isArray(actionRows) ? actionRows : [])
    .filter((r) => r && r.t === 'turn' && r.key)
    .map((r) => ({ key: String(r.key), at: tsOf(r), outcome: String(r.outcome || '') }))
    .filter((r) => r.at > 0)
    .sort((a, b) => a.at - b.at);

  let directedWakes = 0, sent = 0, turnOther = 0, noTurn = 0;
  for (const row of floors) {
    if (row.directed !== true || row.wake !== true) continue;
    // [SEQ] 这条消息已经在上次提示词里出现 → 不是新的“该回”期望，不计入漏接分母。
    if (Number(row.seq) > 0 && Number(row.promptSeq) >= Number(row.seq)) continue;
    const key = String(row.key || '');
    const at = tsOf(row);
    if (!key || !at) continue;
    directedWakes += 1;
    const within = turns.filter((x) => x.key === key && x.at >= at - lookbackMs && x.at - at <= windowMs);
    if (within.some((x) => x.outcome === 'sent')) sent += 1;
    else if (within.length) turnOther += 1;
    else noTurn += 1;
  }
  return {
    v: ENGAGEMENT_METRICS_VERSION,
    directedWakes, sent, turnOther, noTurn, answered: sent, missed: turnOther + noTurn,
    missedRate: directedWakes ? Number(((turnOther + noTurn) / directedWakes).toFixed(3)) : 0,
    noTurnRate: directedWakes ? Number((noTurn / directedWakes).toFixed(3)) : 0,
    turnOtherRate: directedWakes ? Number((turnOther / directedWakes).toFixed(3)) : 0,
    noData: directedWakes === 0,
    windowMs,
    lookbackMs,
  };
}

/** 兼容旧调用：answered=sent，missed=turnOther+noTurn。 */
export function computeMissedDirected(floorRows, actionRows, opts = {}) {
  const c = classifyDirected(floorRows, actionRows, opts);
  return { ...c, answered: c.sent, missed: c.turnOther + c.noTurn };
}
