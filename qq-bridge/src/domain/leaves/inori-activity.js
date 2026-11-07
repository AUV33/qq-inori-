// inori-activity.js · 活动轨迹：她自己做事（玩手机/操作电脑）时自动记录 → 下次自动复用
//
// 为什么需要：trace_log / skill_save / skill_find 三个工具全历史调用 0 次——
// 提示词里写"顺手记"不会发生（已反复验证）。学习必须是确定性的：代码记录、代码检索、
// 代码注入，不依赖模型自觉。
//
// 设计：
//   record()  她每次 phone_* 工具调用时喂进来；同一 App 内的连续操作为一个"活动"
//   finish()  活动结束（她开口说话 / 静默超时）时产出 trace
//   lookup()  下次同 App 活动开始前，取最近成功 trace 注入 prompt
//
// 纯内存 + 文件落盘（data/state/traces/<日期>.jsonl），无外部依赖。

import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, stateDataPath } from '../shared/project-paths.js';
import { readJsonl as readJsonlShared } from './jsonl.mjs';

const TRACE_DIR = stateDataPath('traces');
const INSIGHT_FILE = stateDataPath('insights.jsonl');
const MAX_STEPS = 80;        // 单个活动最多记多少步
const IDLE_FINISH_MS = 180000; // 3 分钟没新操作 -> 活动结束
const LOOKUP_KEEP_DAYS = 14;   // 检索最近 14 天

function ensureDir() {
  try { fs.mkdirSync(TRACE_DIR, { recursive: true }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-activity.js:25'); }
}

/**
 * [INSIGHT] ExpeL 式洞见：从 trace 提炼一条可复用的判断。
 * 这里用规则而不是模型——她有成败信号（卡住/成功）时，规则已经能产出可用洞见，
 * 且确定性、零成本。insights.jsonl 每行 {text, app, kind, votes, at}；
 * votes 到 0 视为无效（对应 ExpeL 的 DOWNVOTE 删除），由调用方决定是否清理。
 */
function appendInsight(insight) {
  try {
    fs.mkdirSync(path.dirname(INSIGHT_FILE), { recursive: true });
    const row = { ...insight, votes: Number(insight.votes ?? 2), at: new Date().toISOString() };
    fs.appendFileSync(INSIGHT_FILE, JSON.stringify(row) + '\n', 'utf8');
    return row;
  } catch { return null; }
}

/** 从一个 trace 提炼洞见（规则版） */
function insightFromTrace(trace) {
  if (!trace) return null;
  const app = trace.app || '(未知)';
  if (trace.stuck) {
    // 卡住：找出重复点的坐标
    const counts = new Map();
    for (const s of trace.steps ?? []) {
      if (s.act !== 'tap') continue;
      const k = `${s.x},${s.y}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      return {
        app,
        kind: 'avoid',
        text: `在「${app}」里点 (${worst[0]}) 连续 ${worst[1]} 次没反应——那里点不出东西，换别的位置或先 dump 看控件。`,
      };
    }
  }
  if (trace.result === 'success' && (trace.steps?.length ?? 0) >= 3) {
    const path = (trace.steps ?? []).slice(0, 12).map((s) => {
      if (s.act === 'tap') return `点(${s.x},${s.y})`;
      if (s.act === 'open') return `开「${s.app}」`;
      if (s.act === 'swipe') return '滑';
      if (s.act === 'look') return '看';
      if (s.act === 'dump') return 'dump';
      if (s.act === 'key') return `键${s.code}`;
      if (s.act === 'input') return `输入「${s.text}」`;
      if (s.act === 'sketch') return `画${s.strokes || 1}笔`;
      return s.act;
    }).join(' → ');
    return { app, kind: 'path', text: `在「${app}」里走通过这条路径：${path}。` };
  }
  return null;
}

function todayFile() {
  const d = new Date();
  const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return path.join(TRACE_DIR, s + '.jsonl');
}

function readJsonl(file) { return readJsonlShared(file); }

/** 从工具名/参数里提取「这一步在干什么」 */
function stepOf(tool, args) {
  const a = args ?? {};
  const name = String(tool ?? '').replace('mcp__phone__', '');
  switch (name) {
    case 'phone_tap': return { act: 'tap', x: a.x, y: a.y };
    case 'phone_swipe': return { act: 'swipe', x: a.x1, y: a.y1, x2: a.x2, y2: a.y2 };
    case 'phone_key': return { act: 'key', code: a.keycode ?? a.key };
    case 'phone_input': return { act: 'input', text: String(a.text ?? '').slice(0, 40) };
    case 'phone_open_app': return { act: 'open', app: String(a.packageName ?? a.package ?? a.app ?? '') };
    case 'phone_look': return { act: 'look', q: String(a.question ?? '').slice(0, 40) };
    case 'phone_dump': return { act: 'dump' };
    case 'phone_launch': return { act: 'launch' };
    case 'phone_sketch': return { act: 'sketch', strokes: Array.isArray(a.strokes) ? a.strokes.length : 1 };
    default: return null;
  }
}

/** 判断这个工具调用是否属于"手机操作" */
export function isPhoneTool(tool) {
  return /^mcp__phone__phone_(tap|swipe|key|input|open_app|look|dump|launch|sketch)$/.test(String(tool ?? ''));
}

export function createActivityTracker() {
  let current = null; // { startedAt, app, steps, taps }

  function reset() { current = null; }

  function record(tool, args, ok) {
    if (!isPhoneTool(tool)) return;
    const step = stepOf(tool, args);
    if (!step) return;
    if (!current) current = { startedAt: Date.now(), app: '', steps: [], taps: [], pendingObservation: false, blindActions: 0 };
    if (step.act === 'open' && step.app) current.app = step.app;
    current.steps.push({ t: Date.now(), ok: !!ok, ...step });
    if (step.act === 'tap') current.taps.push({ x: step.x, y: step.y, ok: !!ok });
    // [ATOMIC] 宪章 §5.8：改状态的动作之后必须有观察（look/dump），否则算盲操作。
    // 只统计，不改变现有发送/学习行为；trace 里给出 blindActions 供后续裁判与熔断使用。
    const observational = step.act === 'look' || step.act === 'dump';
    if (observational) {
      current.pendingObservation = false;
    } else {
      if (current.pendingObservation) current.blindActions = (current.blindActions || 0) + 1;
      current.pendingObservation = true;
    }
    if (current.steps.length > MAX_STEPS) current.steps = current.steps.slice(-MAX_STEPS);
  }

  /** 活动结束：返回 trace（没记录就 null） */
  function finish(reason = 'idle') {
    if (!current || current.steps.length < 3) { reset(); return null; }
    const steps = current.steps;
    const taps = current.taps;
    // 粗判成败：同一坐标重复点 ≥3 次 = 卡住（多半没点中/没反应）
    const stuck = (() => {
      const counts = new Map();
      for (const t of taps) {
        const k = `${t.x},${t.y}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.values()].some((n) => n >= 3);
    })();
    const blindActions = Number(current.blindActions) || 0;
    const trace = {
      at: new Date().toISOString(),
      app: current.app || '(未知)',
      blindActions,
      observed: blindActions === 0,
      steps: steps.map((s) => ({ act: s.act, ...(s.x !== undefined ? { x: s.x, y: s.y } : {}), ...(s.app ? { app: s.app } : {}), ...(s.code !== undefined ? { code: s.code } : {}), ...(s.text ? { text: s.text } : {}), ...(s.strokes !== undefined ? { strokes: s.strokes } : {}) })),
      tapCount: taps.length,
      stuck,
      // [TRACE-TRUTH] 回合正常收尾只代表“跑完了”，不代表事情做成。
      // 没有显式验收时只记 unknown；stuck 仍是 likely_failed。
      result: stuck ? 'likely_failed' : 'unknown',
      reason,
    };
    ensureDir();
    try { fs.appendFileSync(todayFile(), JSON.stringify(trace) + '\n', 'utf8'); } catch (error) {
      try { console.error('[activity] trace 写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-activity.js:161'); }
    }
    // [INSIGHT] 同一条 trace 顺带产出一条洞见（规则版，不花模型钱）
    try {
      const ins = insightFromTrace(trace);
      if (ins) appendInsight(ins);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-activity.js:167'); }
    reset();
    return trace;
  }

  /** 静默超时自动收尾（按**最后一步**的时间算，别把还在进行的活动半路截断） */
  function maybeIdleFinish() {
    if (!current) return null;
    const last = current.steps[current.steps.length - 1]?.t ?? current.startedAt;
    if (Date.now() - last > IDLE_FINISH_MS) return finish('idle_timeout');
    return null;
  }

  /** 检索：同 App 的最近 trace（给下次活动注入"上次怎么做的"） */
  function lookup(app, limit = 2) {
    if (!app) return [];
    const out = [];
    const now = Date.now();
    for (let i = 0; i < LOOKUP_KEEP_DAYS && out.length < limit; i++) {
      const d = new Date(now - i * 86400000);
      const file = path.join(TRACE_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
      const rows = readJsonl(file);
      for (let j = rows.length - 1; j >= 0 && out.length < limit; j--) {
        const r = rows[j];
        if (r && r.app === app && r.steps?.length) out.push(r);
      }
    }
    return out;
  }

  /** 最近有 trace 的 App 列表（去重，最新在前）——给注入用：不知道她这次要开哪个 App， */
  function recentApps(limit = 3) {
    const apps = [];
    const now = Date.now();
    for (let i = 0; i < LOOKUP_KEEP_DAYS && apps.length < limit; i++) {
      const d = new Date(now - i * 86400000);
      const file = path.join(TRACE_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
      const rows = readJsonl(file);
      for (let j = rows.length - 1; j >= 0 && apps.length < limit; j--) {
        const app = rows[j]?.app;
        if (app && app !== '(未知)' && !apps.includes(app)) apps.push(app);
      }
    }
    return apps;
  }

  return { record, finish, maybeIdleFinish, lookup, recentApps, get current() { return current; } };
}

/**
 * 多会话版 tracker：同一进程里聊天会话、任务会话、自主时间都可能调 phone_*，
 * 共用一个 current 会把 A 的步骤接到 B 的轨迹上（turn/end 还会提前截断）。
 * 这里按会话 key 隔离；lookup/recentApps 是文件级只读，仍走同一个 base。
 */
export function createActivityTrackerRegistry() {
  const trackers = new Map();
  const base = createActivityTracker();
  const forKey = (key) => {
    const k = String(key || '(unknown)');
    let t = trackers.get(k);
    if (!t) { t = createActivityTracker(); trackers.set(k, t); }
    return t;
  };
  return {
    forKey,
    record(key, tool, args, ok) { return forKey(key).record(tool, args, ok); },
    finish(key, reason = 'turn_end') {
      const k = String(key || '(unknown)');
      const t = forKey(k);
      const trace = t.finish(reason);
      // [ACTIVITY-GC] finish 后没有进行中的活动就删掉 tracker，避免长期运行 key 只增不减。
      if (!t.current) trackers.delete(k);
      return trace;
    },
    maybeIdleFinishAll() {
      const out = [];
      for (const [key, t] of trackers) {
        const trace = t.maybeIdleFinish();
        if (trace) out.push({ key, trace });
        if (!t.current) trackers.delete(key);
      }
      return out;
    },
    lookup: base.lookup,
    recentApps: base.recentApps,
    get current() { return base.current; },
  };
}

/** 把 trace 渲染成给她的提示（"上次你是这么做的"） */
export function renderTraceHint(traces) {
  if (!Array.isArray(traces) || !traces.length) return '';
  const lines = ['【上次在同一个 App 里，你是这么做的】'];
  for (const t of traces) {
    const acts = (t.steps ?? []).slice(0, 20).map((s) => {
      if (s.act === 'tap') return `点(${s.x},${s.y})`;
      if (s.act === 'swipe') return '滑';
      if (s.act === 'open') return `开「${s.app}」`;
      if (s.act === 'look') return '看';
      if (s.act === 'dump') return 'dump';
      if (s.act === 'key') return `键${s.code}`;
      if (s.act === 'input') return `输入「${s.text}」`;
      if (s.act === 'sketch') return `画${s.strokes || 1}笔`;
      return s.act;
    }).join(' → ');
    const blind = Number(t.blindActions) > 0 ? `（有 ${t.blindActions} 次没看画面就操作）` : '';
    const flag = t.stuck ? '（上次卡住了：同一个位置点了 ≥3 次）' : blind;
    lines.push(`- ${t.app}${flag}：${acts}`);
  }
  lines.push('照着上次能走通的路径做，别重新摸索；上次卡住的地方换个方法。');
  return lines.join('\n');
}

/**
 * [INSIGHT-REUSE] ExpeL 读端通道：把她以前"卡住"和"走通"的洞见喂回做事时刻。
 * 洞见是规则提炼的（insightFromTrace），存 insights.jsonl；这里读回来注入。
 * 只取近 keepDays 天、票数>0、且属于"最近动过的 App"或"(未知)"的条目，去重。
 */
export function renderInsightHints(apps = [], opts = {}) {
  const keepDays = Number(opts.keepDays ?? 14);
  const perKind = Number(opts.perKind ?? 3);
  let rows = [];
  try {
    rows = fs.readFileSync(INSIGHT_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return ''; } // 没有洞见很正常（她还没干过事）
  const cutoff = Date.now() - keepDays * 86400000;
  rows = rows.filter((r) => Number(r.votes ?? 0) > 0 && Date.parse(r.at || 0) >= cutoff);
  const appSet = new Set((apps || []).map(String));
  const inScope = (r) => appSet.has(String(r.app)) || r.app === '(未知)' || r.app === '反思批';
  const seen = new Set();
  const pick = (kind) => rows
    .filter((r) => r.kind === kind && inScope(r))
    .filter((r) => { const k = String(r.app) + '|' + String(r.text); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(-perKind);
  const lines = [];
  const avoids = pick('avoid');
  const paths = pick('path');
  if (avoids.length) lines.push('【你以前在这些地方卡住过（别再撞）】', ...avoids.map((r) => `- ${r.text}`));
  if (paths.length) lines.push('【你以前走通过的路径（直接照走）】', ...paths.map((r) => `- ${r.text}`));
  // [REFLECT-INSIGHT] 反思批的认知线：每日批写一条，只递最新一条（旧账不刷屏）
  const pickLatest = (kind) => rows
    .filter((r) => r.kind === kind && inScope(r) && Number(r.votes ?? 0) > 0 && Date.parse(r.at || 0) >= cutoff)
    .slice(-1);
  const reflects = pickLatest('reflection');
  if (reflects.length) lines.push('【反思批的认知账（确定性统计，非评价）】', ...reflects.map((r) => `- ${r.text}`));
  const tending = pickLatest('group-tendency');
  if (tending.length) lines.push('【群倾向（近48h 确定性聚合）】', ...tending.map((r) => `- ${r.text}`));
  if (!lines.length) return '';
  return lines.join('\n');
}
// [EVOLUTION-TEST] 测试自改日志（2026-10-24）

/**
 * [REFLECT-INSIGHT] 认知层确定性写端（用户拍板 2026-10-25「b」）：
 * 反思批达标收尾后，桥接侧确定性沉淀 1~2 条洞见进 insights.jsonl——零 LLM、零模型成本。
 * ① 经验账：本批反思 +N 条经验 / 目标移动（批次本身即认知：攒了什么、什么状态）。
 * ② 群倾向：各群最近 48h group-digest 的 top 发言者（确定性聚合，不做语义解读）。
 * 认知层此前只从手机操作 trace 产生（insightFromTrace）；对话侧的沉淀缺口由这里补上。
 * @param {{added?:number, after?:number, goalsMoved?:number, ok?:boolean, date?:string}} outcome
 * @param {{memoryDir?:string}} [opts]
 * @returns {number} 写入的洞见行数
 */
/**
 * 从群-digest 文本确定性聚合发言者（不做语义解读；群记忆 group-fact 与反思批共用同一实现）。
 * 段格式：[23:08–23:44] 群里在聊：A：xx / B：yy（withWindow 前缀 + 「群里在聊：」前缀）。
 * 先剥前缀再取发言者名；纯数字项（时间冒号）不计数。
 * @param {string[]} digestTexts
 * @param {{limit?:number}} [opts]
 * @returns {{speakers:{name:string,count:number}[], total:number}}
 */
export function summarizeGroupSpeakers(digestTexts, opts = {}) {
  const topN = Math.max(1, Number(opts.limit) || 3);
  const speakers = new Map();
  let total = 0;
  for (const text of Array.isArray(digestTexts) ? digestTexts : []) {
    for (const seg of String(text ?? '').split(' / ')) {
      const body = seg.replace(/^\[\d{2}:\d{2}–\d{2}:\d{2}\]\s*/, '').replace(/^群里在聊：/, '');
      const m = body.match(/^[^：:]{1,12}：/);
      if (!m) continue;
      const n = m[0].slice(0, -1).trim();
      if (!n || /^\d+$/.test(n)) continue;
      speakers.set(n, (speakers.get(n) || 0) + 1);
      total += 1;
    }
  }
  const list = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
    .map(([name, count]) => ({ name, count }));
  return { speakers: list, total };
}

export function writeReflectInsight(outcome, opts = {}) {
  const written = [];
  try {
    const date = String(outcome?.date ?? new Date().toLocaleDateString('sv-SE'));
    // ① 经验账
    const added = Number(outcome?.added) || 0;
    const after = Number(outcome?.after) || 0;
    const moved = Number(outcome?.goalsMoved) || 0;
    written.push(appendInsight({
      app: '反思批',
      kind: 'reflection',
      text: `反思批（${date}）：经验 +${added}（累计 ${after}），目标${moved > 0 ? `移动 ${moved} 件` : '没动'}。`,
      votes: 2,
    }));
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-activity.js:372'); }
  try {
    // ② 群倾向（确定性聚合）
    const dir = opts.memoryDir || MEMORY_DIR;
    const since = Date.now() - 48 * 3600000;
    const perGroup = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (!/^memory-group_.*\.jsonl$/.test(f)) continue;
      const gid = f.replace(/^memory-group_/, '').replace(/\.jsonl$/, '');
      let rows = [];
      try {
        rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { continue; }
      const digests = rows.filter((r) => {
        if (r?.kind !== 'group-digest') return false;
        const t = Date.parse(String(r.time || '').replace(' ', 'T'));
        return Number.isFinite(t) && t >= since;
      }).map((r) => String(r.text ?? ''));
      const { speakers } = summarizeGroupSpeakers(digests, { limit: 2 });
      if (!speakers.length) continue;
      perGroup.set(gid, speakers.map((s) => s.name).join('/'));
    }
    if (perGroup.size) {
      written.push(appendInsight({
        app: '反思批',
        kind: 'group-tendency',
        text: `群倾向（近48h）：${[...perGroup.entries()].map(([g, t]) => `${g} 最活跃：${t}`).join('；')}`,
        votes: 2,
      }));
    }
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-activity.js:403'); }
  return written.filter(Boolean).length;
}
