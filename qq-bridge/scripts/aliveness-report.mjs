#!/usr/bin/env node
// aliveness-report.mjs · Aliveness Index：把“她活到什么程度”变成可复算的数字
//
// 对应蓝图 §7（验收：Aliveness Index）。原则：模型自报告不算证据，只从日志/状态确定性计算；
// 没有数据的维度记 no-data（0 分）并标注覆盖度，不假装。
//
// 用法：
//   node scripts/aliveness-report.mjs                 # 文本报告（最近 7 天）
//   node scripts/aliveness-report.mjs --json          # 机器可读
//   node scripts/aliveness-report.mjs --days 30
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
import { computeMissedDirected } from '../src/domain/mind/engagement-metrics.mjs';
import { obsPaths } from './lib/observability-paths.mjs';

const DAY = 86400000;
const DIMENSIONS = [
  { key: 'continuity', name: '连续性', weight: 15 },
  { key: 'autonomy', name: '自主性', weight: 20 },
  { key: 'homeostasis', name: '稳态', weight: 15 },
  { key: 'social', name: '社会耦合', weight: 15 },
  { key: 'memory', name: '记忆', weight: 15 },
  { key: 'growth', name: '成长', weight: 10 },
  { key: 'integrity', name: '完整性', weight: 10 },
];

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function listDir(dir, pattern) {
  try { return fs.readdirSync(dir).filter((f) => pattern.test(f)); } catch { return []; }
}

function withinDays(row, cutoff) {
  let at = Number(row?.at);
  if (!Number.isFinite(at) && typeof row?.at === 'string') at = Date.parse(row.at);
  if (!Number.isFinite(at)) at = Number(row?.ts);
  if (!Number.isFinite(at) && typeof row?.ts === 'string') at = Date.parse(row.ts);
  if (!Number.isFinite(at)) at = 0;
  return at >= cutoff;
}

function eventsIn(root, cutoff) {
  const dir = obsPaths(root).lifeLog;
  const out = [];
  for (const file of listDir(dir, /^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
    for (const row of readJsonl(path.join(dir, file))) {
      if (withinDays(row, cutoff)) out.push(row);
    }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * 被接住率：她发出的一条消息，30 分钟内同会话是否有人回。
 * 只信生命线事件（message.sent / message.received），不回看聊天正文。
 */
export function computeCaughtRate(events, { windowMs = 30 * 60 * 1000 } = {}) {
  const rows = (Array.isArray(events) ? events : [])
    .filter((e) => e && (e.type === 'message.sent' || e.type === 'message.received'))
    .slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  const lastSent = new Map();
  const caught = new Set();
  for (const e of rows) {
    const key = String(e.key || '');
    if (e.type === 'message.sent') lastSent.set(key, e);
    else if (e.type === 'message.received') {
      const sent = lastSent.get(key);
      if (sent && (Number(e.at) || 0) - (Number(sent.at) || 0) <= windowMs) {
        caught.add(String(sent.id || sent.at));
        lastSent.delete(key);
      }
    }
  }
  const sends = rows.filter((e) => e.type === 'message.sent').length;
  return { sends, caught: caught.size, rate: sends ? Number((caught.size / sends).toFixed(3)) : 0 };
}

function countMemoryEntries(root) {
  const P = obsPaths(root);
  const dir = P.memory;
  let total = 0;
  let withProvenance = 0;
  let archived = 0;
  for (const file of listDir(dir, /^memory.*\.jsonl$/)) {
    for (const row of readJsonl(path.join(dir, file))) {
      total += 1;
      if (row.src || row.source || row.who || row.provenance) withProvenance += 1;
    }
  }
  for (const file of listDir(path.join(dir, '_archive'), /^memory.*\.jsonl$/)) {
    archived += readJsonl(path.join(dir, '_archive', file)).length;
  }
  return { total, withProvenance, archived };
}

/**
 * @param {{root?:string, days?:number, now?:number}} opts
 */
export function buildAlivenessReport(opts = {}) {
  const root = path.resolve(opts.root || PROJECT_ROOT);
  const P = obsPaths(root);
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 7;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cutoff = now - days * DAY;

  const events = eventsIn(root, cutoff);
  const actionLog = readJsonl(P.actionLog).filter((r) => withinDays(r, cutoff));
  const floorLog = readJsonl(P.floorDecisions).filter((r) => withinDays(r, cutoff));
  const lessons = readJsonl(P.lessons);
  const evolution = readJsonl(P.evolution).filter((r) => withinDays(r, cutoff));
  const selfState = readJson(P.selfState, null);
  const beliefs = readJson(P.beliefs, null);
  const narrative = readJson(P.offlineNarrative, null);
  const memory = countMemoryEntries(root);

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  const turnTriggers = {};
  for (const row of actionLog) {
    if (row.t === 'turn') {
      const trig = String(row.trigger || '');
      turnTriggers[trig] = (turnTriggers[trig] || 0) + 1;
    }
  }
  const totalTurns = Object.values(turnTriggers).reduce((a, b) => a + b, 0);
  const proactive = ['proactiveCheck', 'selfWake', 'probability', 'joinTopic']
    .reduce((sum, key) => sum + (turnTriggers[key] || 0), 0);
  const proactiveRatio = totalTurns ? proactive / totalTurns : 0;

  const dims = {};

  // 1) 连续性：生命线事件 + 启动次数 + 离线叙事 + 信念
  {
    const eventDays = new Set(events.map((e) => new Date(Number(e.at) || 0).toISOString().slice(0, 10))).size;
    const starts = counts['process.started'] || 0;
    const hasNarrative = narrative && typeof narrative.text === 'string' && narrative.text.length > 0 ? 1 : 0;
    const people = beliefs && beliefs.people ? Object.keys(beliefs.people).length : 0;
    // 连续性：覆盖天数 + 离线叙事 + 认识的人；启动次数只作为证据记录，不再当作“连续”的加分
    // （启动多往往意味着不稳定，不能把重启算成优点）。
    const score = 0.4 * clamp01(eventDays / Math.min(days, 3)) + 0.3 * hasNarrative + 0.3 * clamp01(people / 5);
    dims.continuity = {
      score, evidence: { eventDays, starts, hasNarrative, people, events: events.length },
      status: events.length ? 'measured' : 'no-data',
    };
  }

  // 2) 自主性：自主动作占比 + 意图影子
  {
    const shadows = counts['intention.shadow'] || 0;
    const ratioScore = clamp01(proactiveRatio / 0.25);
    const shadowScore = clamp01(shadows / 10);
    const score = 0.7 * ratioScore + 0.3 * shadowScore;
    dims.autonomy = {
      score, evidence: { proactive, totalTurns, proactiveRatio: Number(proactiveRatio.toFixed(3)), shadows },
      status: totalTurns || shadows ? 'measured' : 'no-data',
    };
  }

  // 3) 稳态：自我状态存在/有界 + tick + 睡眠事件
  {
    let bounded = 0;
    let fields = 0;
    if (selfState && typeof selfState === 'object') {
      for (const key of ['energy', 'sleepDebt', 'socialHunger', 'curiosity', 'competence', 'stress', 'valence', 'arousal', 'mood']) {
        if (Number.isFinite(selfState[key])) {
          fields += 1;
          if (selfState[key] >= 0 && selfState[key] <= 1) bounded += 1;
        }
      }
    }
    const ticks = counts['life.tick'] || 0;
    const sleeps = counts['sleep.started'] || 0;
    const score = 0.4 * clamp01(bounded / 9) + 0.3 * clamp01(ticks / days) + 0.3 * clamp01(sleeps / days);
    dims.homeostasis = {
      score, evidence: { fields, bounded, ticks, sleeps },
      status: selfState ? 'measured' : 'no-data',
    };
  }

  // 4) 社会耦合：收发事件（生命线）+ 楼层决策 + 回复占比
  {
    const received = counts['message.received'] || 0;
    const sent = counts['message.sent'] || 0;
    const keys = new Set(events.filter((e) => e.type === 'message.received' || e.type === 'message.sent').map((e) => e.key).filter(Boolean)).size;
    const sentTurns = actionLog.filter((r) => r.t === 'turn' && r.outcome === 'sent').length;
    const directed = floorLog.filter((r) => r.directed === true).length;
    const caught = computeCaughtRate(events);
    const missed = computeMissedDirected(floorLog, actionLog);
    const answerRate = missed.noData ? 0 : 1 - missed.missedRate;
    // [SENT-PARITY] 生命线 message.sent 是 11-03 才接的新观测，7 天窗口里绝大多数 sent 回合
    // 发生在接线之前（实测 sent=6 vs sentTurns=113）。旧公式把 0.25 权重压在这个稀疏计数上，
    // 等于让"接线日期"决定社会耦合分。改用覆盖整窗的 sentTurns，并显式标注生命线覆盖天数，
    // 不回填历史、不假装两个口径一致。
    const lifeDays = new Set(events.map((e) => new Date(Number(e.at) || 0).toISOString().slice(0, 10))).size;
    const score = 0.3 * clamp01((received + sent) / 40) + 0.15 * clamp01(keys / 3)
      + 0.2 * clamp01(sentTurns / 30) + 0.05 * caught.rate + 0.05 * answerRate + 0.25 * clamp01(sentTurns / 10);
    dims.social = {
      score,
      evidence: {
        received, sent, keys, sentTurns, directedFloor: directed,
        lifeLogDays: lifeDays, sentSource: 'action-log.turn[outcome=sent]',
        caught: caught.caught, caughtRate: caught.rate,
        directedWakes: missed.directedWakes, missedDirected: missed.missed, missedRate: missed.missedRate,
      },
      status: received + sent + sentTurns ? 'measured' : 'no-data',
    };
  }

  // 5) 记忆：条目规模 + 溯源覆盖 + 归档
  {
    const scale = clamp01(memory.total / 1000);
    const provenance = memory.total ? memory.withProvenance / memory.total : 0;
    const archived = clamp01(memory.archived / 200);
    const score = 0.45 * scale + 0.35 * provenance + 0.2 * archived;
    dims.memory = {
      score, evidence: { total: memory.total, withProvenance: memory.withProvenance, archived: memory.archived },
      status: memory.total ? 'measured' : 'no-data',
    };
  }

  // 6) 成长：经验 + 反思 + 演化
  {
    const reflections = counts['reflection.completed'] || 0;
    const score = 0.45 * clamp01(lessons.length / 100) + 0.3 * clamp01(reflections / days) + 0.25 * clamp01(evolution.length / 50);
    dims.growth = {
      score, evidence: { lessons: lessons.length, reflections, evolution: evolution.length },
      status: lessons.length + reflections + evolution.length ? 'measured' : 'no-data',
    };
  }

  // 7) 完整性：必须有独立审计来源才算数；没有就中性 0.5 + no-data，不能用“0 错误”冒充满分。
  {
    const errors = counts['error.observed'] || 0;
    const audit = readJson(P.securityAudit, null);
    const hasAudit = audit && typeof audit === 'object';
    const actions = events.length + totalTurns;
    const errorRate = actions ? errors / actions : 0;
    const evidence = hasAudit ? clamp01(1 - errorRate * 10 - (Number(audit.high) || 0) * 0.2) : 0.5;
    dims.integrity = {
      score: evidence,
      evidence: { errors, actions, errorRate: Number(errorRate.toFixed(4)), audit: hasAudit ? 'present' : 'missing' },
      status: hasAudit ? 'measured' : 'no-data',
    };
  }

  const measured = DIMENSIONS.filter((d) => dims[d.key].status === 'measured');
  const totalWeight = DIMENSIONS.reduce((a, d) => a + d.weight, 0);
  const weighted = DIMENSIONS.reduce((a, d) => a + d.weight * dims[d.key].score, 0);
  const index = Number(((weighted / totalWeight) * 100).toFixed(1));
  const coverage = Number((measured.reduce((a, d) => a + d.weight, 0) / totalWeight).toFixed(3));

  return {
    v: 1,
    at: now,
    days,
    index,
    coverage,
    dimensions: DIMENSIONS.map((d) => ({ ...d, ...dims[d.key], score: Number(dims[d.key].score.toFixed(3)) })),
    sources: {
      events: events.length,
      actionLog: actionLog.length,
      floorLog: floorLog.length,
      lessons: lessons.length,
      evolution: evolution.length,
    },
  };
}

/** 读历史日报（只读）；坏文件跳过。按日期升序返回 [{day,index,coverage,dimensions}]。 */
export function loadAlivenessHistory(root = PROJECT_ROOT, { limit = 30 } = {}) {
  const dir = obsPaths(root).alivenessDir;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return []; }
  const rows = [];
  for (const name of names.slice(-Math.max(1, limit))) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      rows.push({
        day: name.slice(0, 10),
        index: Number(doc.index) || 0,
        coverage: Number(doc.coverage) || 0,
        dimensions: Array.isArray(doc.dimensions) ? doc.dimensions : [],
      });
    } catch { /* 坏文件跳过 */ }
  }
  return rows;
}

/**
 * 回归门禁：把最新一天与前一天比较；总分跌超过 maxDrop 或某维跌超过 maxDimensionDrop 即失败。
 * 没有两天数据时 noBaseline=true（不阻塞）。
 */
export function checkAlivenessRegression(rows, { maxDrop = 5, maxDimensionDrop = 0.15 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return { ok: true, noBaseline: true, drops: [] };
  const prev = list[list.length - 2];
  const cur = list[list.length - 1];
  const drops = [];
  if (prev.index - cur.index > maxDrop) {
    drops.push({ kind: 'index', from: prev.index, to: cur.index, delta: Number((cur.index - prev.index).toFixed(1)) });
  }
  for (const d of cur.dimensions || []) {
    const before = (prev.dimensions || []).find((x) => x.key === d.key);
    if (!before || !Number.isFinite(before.score) || !Number.isFinite(d.score)) continue;
    if (before.score - d.score > maxDimensionDrop) {
      drops.push({ kind: 'dimension', key: d.key, name: d.name, from: before.score, to: d.score, delta: Number((d.score - before.score).toFixed(3)) });
    }
  }
  return { ok: drops.length === 0, noBaseline: false, prev: prev.day, cur: cur.day, drops };
}

/** 渲染趋势：每天一行 + 相邻日变化；最后一列给各维度的最新变化。 */
export function renderTrend(rows) {
  if (!rows.length) return '暂无历史日报（先运行 --write 生成）';
  const lines = ['日期 | 总分 | 覆盖 | 日变化'];
  lines.push('---|---|---|---');
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const delta = i === 0 ? '-' : (r.index - rows[i - 1].index >= 0 ? '+' : '') + (r.index - rows[i - 1].index).toFixed(1);
    lines.push(r.day + ' | ' + r.index.toFixed(1) + ' | ' + Math.round(r.coverage * 100) + '% | ' + delta);
  }
  const last = rows[rows.length - 1];
  if (last.dimensions?.length) {
    lines.push('');
    lines.push('最新分维（' + last.day + '）：');
    for (const d of last.dimensions) {
      const prev = rows.length > 1 ? rows[rows.length - 2].dimensions?.find((x) => x.key === d.key) : null;
      const dd = prev && Number.isFinite(prev.score) && Number.isFinite(d.score) ? d.score - prev.score : null;
      lines.push('- ' + d.name + ' ' + Number(d.score || 0).toFixed(2) + (dd === null ? '' : '（' + (dd >= 0 ? '+' : '') + dd.toFixed(2) + '）'));
    }
  }
  return lines.join('\n');
}

/** 把报告落盘到 data/reports/aliveness/<date>.{json,md}（只读数据的派生，不参与决策）。 */
export function writeAlivenessReport(report, opts = {}) {
  const root = path.resolve(opts.root || PROJECT_ROOT);
  const dir = obsPaths(root).alivenessDir;
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(opts.now || report.at || Date.now());
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const jsonFile = path.join(dir, day + '.json');
  const mdFile = path.join(dir, day + '.md');
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 1) + '\n', 'utf8');
  fs.writeFileSync(mdFile, renderReport(report) + '\n', 'utf8');
  return { json: jsonFile, md: mdFile, day };
}

export function renderReport(report) {
  const lines = [];
  lines.push('Aliveness Index: ' + report.index + ' / 100（覆盖度 ' + Math.round(report.coverage * 100) + '%，最近 ' + report.days + ' 天）');
  lines.push('');
  lines.push('| 维度 | 权重 | 分数 | 状态 | 证据 |');
  lines.push('|---|---|---|---|---|');
  for (const d of report.dimensions) {
    const ev = Object.entries(d.evidence).map(([k, v]) => k + '=' + v).join(' ');
    lines.push('| ' + d.name + ' | ' + d.weight + ' | ' + d.score.toFixed(2) + ' | ' + d.status + ' | ' + ev + ' |');
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const write = args.includes('--write');
  const trend = args.includes('--trend');
  const check = args.includes('--check');
  const di = args.indexOf('--days');
  const days = di >= 0 ? Number(args[di + 1]) || 7 : 7;
  if (trend) {
    console.log(renderTrend(loadAlivenessHistory(PROJECT_ROOT, { limit: Number(di >= 0 ? args[di + 1] : 30) || 30 })));
    process.exit(0);
  }
  if (check) {
    const history = loadAlivenessHistory(PROJECT_ROOT, { limit: 30 });
    const verdict = checkAlivenessRegression(history);
    console.log(JSON.stringify(verdict, null, 1));
    if (!verdict.ok) process.exitCode = 1;
    process.exit(process.exitCode || 0);
  }
  const report = buildAlivenessReport({ days });
  console.log(json ? JSON.stringify(report, null, 1) : renderReport(report));
  if (write) {
    try {
      const out = writeAlivenessReport(report);
      console.log('\n已写入：' + out.json + '\n         ' + out.md);
    } catch (error) {
      console.error('写报告失败：' + (error?.message ?? error));
      process.exitCode = 1;
    }
  }
}
