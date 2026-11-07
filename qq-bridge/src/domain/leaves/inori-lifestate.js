// inori-lifestate.js · 生活状态机 + 生理层（灵活作息 · 内稳态）
//
// 设计来源：
//   · mizuse core/life_state.py + _life_state_at：状态由代码算，不由话语算
//   · ICLR 2026 CFSM（Codified FSM for Role-playing）的确定性简化版
//   · 生理层参照 mizuse ctx_render 的「具身与有限：时间曲线 + 睡眠状态 + 精力值」
//     以及人类睡眠压力（homeostatic + circadian 双过程）的极简化
//
// ★ 核心原则：她说"我睡了"之前，先问她的身体"扛不扛得住"。
//   熬夜不是"她说了"，是"她的债堆起来了"——作息偏移是结果，不是前提。
//
// 两层结构：
//   ① 活动状态（事件驱动）：sleep / waking / active / idle
//   ② 生理量（tick 推进，纯确定性）：
//      - debt      睡眠债 [0,1]：睡不够堆上来，睡着慢慢还（4h 还清）
//      - pressure  昼夜压力 [0,1]：随「距动态就寝点 bedAt」的时程自然起伏
//      - drowsy    困意 = clamp(0.55*debt + 0.45*pressure)
//      - bedAt     动态就寝点（分钟）：过去 7 段睡眠开始时刻的加权均值（越近越重），
//                 没记录时软默认 23:30——连续熬夜后它自然移向凌晨，这就是"偏移"
//      - driftDays 连续偏离理想就寝（23:10）超 2h 的天数（P2 反思素材，不强制纠正）
//
// 自主成因（状态过线 → 行为改变，不经过他）：
//   drowsy ≥ 0.85 且 25 分钟无消息 → 自动入睡（auto_sleep），有记录
//
// 约束（继承 inori-state.js 六约）：
//   有界 [0,1] / tick 只依赖 (state, now) 可重放 / enabled=false 全链路空转不落盘
// 落盘：data/state/life.json

import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';
import { humanizeGap, humanizeDuration } from '../conversation/time-words.js';

const DEFAULT_PATH = stateDataPath('life.json');
const DEFAULTS = {
  enabled: true,
  wakeWindowMs: 45 * 60000,     // 被唤醒窗口（mizuse 设计）
  idleAfterMs: 30 * 60000,
  autoSleepDrowsy: 0.85,        // 困意过线才允许"自然睡过去"
  autoSleepQuietMs: 25 * 60000, // 且 25 分钟没消息
  debtRepayPerH: 0.25,          // 睡 4h 还清全部债
  debtAccPerH: 0.10,           // 醒着基础堆积
  debtLateFactor: 0.25,        // 过就寝点后的追加堆积率
  idealBedMin: 23 * 60 + 10,   // 理想就寝 23:10（drift 判定的参照）
  driftLimitMin: 120,          // 偏离 2h 才算"作息乱了"
  // [FORCE-NAP] 债顶格强制小睡：自然入睡要求困意 ≥0.85 = 0.55·debt + 0.45·昼夜压力，
  // 白天压力低（≈0.3）时困意只有 0.68，债停在 1.0 永远睡不着 → [motive] 永久跳过
  // probability/recovery 唤醒（2026-10-30 实测 debt=1.00、sleepLog 空、一天跳 6 次）。
  forceSleepDebt: 0.95,        // 债到这个数……
  forceSleepAfterMs: 30 * 60000, // ……持续这么久就强制睡
  forceSleepQuietMs: 20 * 60000, // 且至少这么久没人来找她（别在对话中间睡过去）
  quietForMs: Number.POSITIVE_INFINITY, // 由调用方每 tick 传入：距上一条进来的消息多久
  napWakeDebt: 0.7,            // 强制小睡睡到债 ≤ 这个数……
  minSleepMs: 90 * 60000,      // ……且至少睡这么久，才醒
  maxSleepMs: 8 * 3600000,     // 任何睡眠最长 8h 兜底
};

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// ── 昼夜压力曲线（纯时间函数，相对动态 bedAt）────────────────────────
// 距就寝点 d 分钟（mod 1440）：刚过线最困，午前低谷，傍晚回升。
export function circadianPressure(nowMin, bedAt) {
  let d = ((nowMin - bedAt) % 1440 + 1440) % 1440;
  if (d < 60) return 0.75 + 0.004 * d;          // 刚过线 0.75→0.99
  if (d < 300) return 1.0;                      // 后半夜顶点
  if (d < 540) return 0.9;                      // 清晨
  if (d < 780) return 0.5;                      // 上午
  if (d < 960) return 0.2;                      // 午后低谷
  if (d < 1080) return 0.3;                     // 傍晚
  return 0.3 + 0.45 * ((d - 1080) / 360);       // 入夜回升 → 就寝点 0.75
}

// ── 动态就寝点：过去 7 段睡眠的开始时刻加权均值（近 4:3:2:1）────────
function bedFromLog(sleepLog, fallback = 23 * 60 + 30) {
  const xs = (sleepLog || []).slice(-7).map((sl) => {
    let m = Number(sl.startMin);
    if (!Number.isFinite(m)) return null;
    m = ((m % 1440) + 1440) % 1440;
    if (m < 360) m += 1440; // 0-6 点的入睡按 24-30 点算（扩展刻度）
    return m;
  }).filter((v) => v !== null);
  if (!xs.length) return fallback;
  const w = xs.map((_, i) => i + 1); // xs 末尾是最新的 → 权重递增
  const W = w.reduce((a, b) => a + b, 0);
  const mean = xs.reduce((a, v, i) => a + v * w[i], 0) / W; // 扩展刻度上取均值
  return Math.round(((mean % 1440) + 1440) % 1440);
}

export function currentBedAt(state, cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg ?? {}) };
  return bedFromLog(state.sleepLog, 23 * 60 + 30) || Math.round((o.idealBedMin + 20));
}

// ── 落盘结构 ──────────────────────────────────────────────────────────
export function loadLifeState(file = DEFAULT_PATH, cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg ?? {}) };
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = {}; }
  s = {
    state: 'idle',
    stateChanged: Date.now(),
    sleepSince: null,
    sleepOrigin: null,          // 'declared' 她说的 / 'auto' 她自然睡过去的
    wakeUntil: 0,
    debt: 0.2,
    highDebtSince: 0,          // [FORCE-NAP] 债 ≥ forceSleepDebt 的起始时刻；0 = 没在顶格
    lastPhysTick: 0,
    sleepLog: [],              // {startMin, endMin, hours, ts}
    driftDays: 0,
    driftCheckedDay: '',
    sleepNotes: 0,             // 今天她声明睡几次
    activeAfterSleep: 0,       // 声明睡后又活动几次（P2）
    at: Date.now(),
    enabled: true,
    ...s,
  };
  s.state = ['sleep', 'waking', 'active', 'idle'].includes(s.state) ? s.state : 'idle';
  s.sleepSince = Number(s.sleepSince) || null;
  s.sleepOrigin = s.sleepOrigin || null;
  s.wakeUntil = Number(s.wakeUntil) || 0;
  s.debt = clamp01(s.debt);
  s.lastPhysTick = Number(s.lastPhysTick) || 0;
  s.sleepLog = Array.isArray(s.sleepLog) ? s.sleepLog.slice(-30) : [];
  s.driftDays = Number(s.driftDays) || 0;
  s.driftCheckedDay = String(s.driftCheckedDay || '');
  s.sleepNotes = Number(s.sleepNotes) || 0;
  s.activeAfterSleep = Number(s.activeAfterSleep) || 0;
  s.lastInterestAt = Number(s.lastInterestAt) || 0;
  s.boreLastAt = Number(s.boreLastAt) || 0;
  s.boreCount = Number(s.boreCount) || 0;
  s.boreDay = String(s.boreDay || '');
  s.at = Number(s.at) || Date.now();
  if (!Number.isFinite(s.stateChanged) || s.stateChanged <= 0) s.stateChanged = s.at;
  return s;
}

// ── 无聊度（内稳态第四量：动机驱动，不是时钟驱动）────────────────
// 活人会"闲得没事干"——越久没发生有意思的事，越想找事做。
// boredom = 1 - exp(-idleMin/K)，K 默认 90 分钟：90 分钟→0.63，180→0.86，270→0.95
// 有界 [0,1]、纯 (state, now) 可重放；睡觉时不算无聊（睡着了不痒）。
/** 好奇刺激史（[P1] 驱动量）：她的探索行为（搜/看视频/翻词/挂心）积累好奇，3h 自然衰减。
 *  纯函数：给 (state, now) 可重放。stimuli = [{ts, w}]（w=强度 0-1）。 */
export function curiosityOf(state, now = Date.now(), cfg = {}) {
  if (!state || state.enabled === false) return 0;
  if (state.state === 'sleep') return 0;
  const H = (Number(cfg?.curiosityHalfLifeMin) || 180) * 60000; // 半衰期默认 3h
  const lam = Math.LN2 / H; // 指数衰减系数
  let sum = 0;
  for (const s of state.curiosityStimuli ?? []) {
    const age = now - Number(s.ts || 0);
    if (age < 0 || age > 6 * 3600000) continue; // 超过 6h 的不算（也顺手清掉）
    sum += Math.max(0.05, Number(s.w) || 0.5) * Math.exp(-lam * age);
  }
  return Math.min(1, sum);
}

/** 记录一次好奇刺激（她的主动探索行为）。cap 24 条，只留最近 6h。 */
export function curiosityStimulus(state, w = 0.6, now = Date.now()) {
  const s = { ...state };
  const list = [...(s.curiosityStimuli ?? [])];
  const sixH = now - 6 * 3600000;
  s.curiosityStimuli = [...list.filter((x) => x.ts > sixH), { ts: now, w: Math.min(1, Math.max(0.05, Number(w) || 0.5)) }].slice(-24);
  return s;
}

/** 好奇度过线时的驱动线（描述状态，不派活）：≥0.6 出一行；否则 null。 */
export function renderCuriosityDrive(state, now = Date.now(), cfg = {}) {
  const c = curiosityOf(state, now, cfg);
  if (c < 0.6) return null;
  return c >= 0.85
    ? '你脑子里最近一直有根线在动（挂心的事 / 新东西）——顺着它走也行，放着也行。'
    : '你最近有点来劲（脑子比平时热）。';
}

export function boredomOf(state, now = Date.now(), cfg = {}) {
  if (!state || state.enabled === false) return 0;
  if (state.state === 'sleep') return 0;
  const K = (Number(cfg?.boredomKMin) || 90) * 60000;
  const last = Number(state.lastInterestAt || 0);
  if (!last) return 0.5; // 没数据按半无聊算（保守）
  return Math.min(1, 1 - Math.exp(-Math.max(0, now - last) / K));
}

/** 有"有意思的事"发生（对话/任务/操作/投递）→ 无聊度归零锚点 */
export function markInterest(state, now = Date.now()) {
  if (!state) return state;
  state.lastInterestAt = now;
  return state;
}

export function saveLifeState(state, file = DEFAULT_PATH) {
  if (!state || state.enabled === false) return;
  try {
    // 原子写（tmp+rename）：崩溃不留半截 JSON（life.json 是她的实时状态，损坏=降级成默认状态）
    const r = writeJsonDocument(file, state, { source: 'bridge/lifestate' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteJson(file, state, { pretty: true });
    }
  } catch (error) {
    try { console.error('[lifestate] 落盘失败（不挡主链路）:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-lifestate.js:202'); }
  }
}

/** 她声明睡觉（确定性匹配，只认她自己发的短句） */
const SLEEP_PAT = /我要?睡了|先睡了|睡了啊?|困死|困了.*睡|晚安|去睡|准备睡|要睡觉|眼皮.*(沉|打架)|不撑了/;
export function detectSleepClaim(text) {
  const t = String(text ?? '');
  if (!t || t.length > 60) return false;
  return SLEEP_PAT.test(t);
}
/** "今晚睡晚"（睡晚 = 少还债，直接体现为债基线抬一点） */
const LATE_PAT = /今晚睡晚|睡晚点?|熬.{0,4}夜|不睡了|再玩.{0,6}(会|一会儿|下)|还没困/;
export function detectLateSleepClaim(text) {
  const t = String(text ?? '');
  if (!t || t.length > 60) return false;
  return LATE_PAT.test(t);
}

/** 当前困意（纯函数，只依赖 (state, now)） */
export function drowsinessOf(state, now = Date.now(), cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg ?? {}) };
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const bedAt = currentBedAt(state, o);
  const pressure = circadianPressure(nowMin, bedAt);
  return clamp01(0.55 * state.debt + 0.45 * pressure);
}

/**
 * 生理 tick（桥接每 5 分钟一次）：推进 debt、记睡眠段、判自动入睡、跨天判 drift。
 * 纯计算，返回 {state, events[]}（events 供调用方记日志/触发）。
 */
export function physTick(state, now = Date.now(), cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg ?? {}) };
  const s = { ...state };
  const events = [];
  const dtH = Math.max(0, Math.min(3, (now - (s.lastPhysTick || now)) / 3600000));
  s.lastPhysTick = now;
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const bedAt = currentBedAt(s, o);

  if (s.state === 'sleep' && s.sleepSince) {
    // 还债；债还完或睡满 6h，且已到清晨段 → 自然醒（灵活作息：没有固定起床点）
    s.debt = clamp01(s.debt - o.debtRepayPerH * dtH);
    const hours = (now - s.sleepSince) / 3600000;
    const clearish = s.debt < 0.15;
    const morning = nowMin >= 5 * 60 + 30 && nowMin < 11 * 60;
    // [FORCE-NAP] 强制小睡不看早晨窗口：睡够 minSleepMs 且债已降到 napWakeDebt 以下就醒，
    // 否则下午被强制睡的那一觉会一直躺到第二天早上（>12h）。任何睡眠 8h 兜底。
    const napDone = s.sleepOrigin === 'force' && hours >= o.minSleepMs / 3600000 && s.debt <= o.napWakeDebt;
    const sleptMax = hours >= o.maxSleepMs / 3600000;
    if (((clearish || hours >= 6) && morning) || napDone || sleptMax) {
      s.sleepLog.push({ startMin: minutesOf(s.sleepSince), endMin: nowMin, hours: +hours.toFixed(2), ts: now });
      s.sleepLog = s.sleepLog.slice(-30);
      s.state = 'idle';
      s.sleepSince = null;
      s.sleepOrigin = null;
      s.highDebtSince = 0;
      s.stateChanged = now;
      events.push({ type: 'auto_wake', debt: +s.debt.toFixed(3), hours: +hours.toFixed(2) });
    }
  } else {
    // 醒着：基础堆积 + 过就寝点追加
    const late = ((nowMin - bedAt) % 1440 + 1440) % 1440; // 距就寝点过了多少分钟
    const rate = o.debtAccPerH + (late >= 0 && late <= 1439 ? o.debtLateFactor : 0);
    s.debt = clamp01(s.debt + rate * dtH);
    // [FORCE-NAP] 记录「债顶格」起点：跌回 0.85 以下才算还清，避免在阈值上抖动反复清零。
    if (s.debt >= o.forceSleepDebt) {
      if (!s.highDebtSince) s.highDebtSince = now;
    } else if (s.debt < o.forceSleepDebt - 0.1) {
      s.highDebtSince = 0;
    }
  }

  // 被唤醒窗口到期 → 回 idle
  if (s.state === 'waking' && s.wakeUntil && now > s.wakeUntil) {
    s.state = 'idle';
    s.wakeUntil = 0;
    s.stateChanged = now;
  }

  // 自动入睡（自主成因：困意过线 + 非刚被唤醒——刚被叫醒的 45 分钟窗口内不自动睡回去，
  // 否则深夜被@醒后下一 tick 困意又过线，人永远睡不安稳）
  // [FORCE-NAP] 债顶格超过 forceSleepAfterMs → 无视困意曲线与唤醒窗口强制睡：
  // 自然入睡只在夜里压力高时能触发，白天债满只会一直醒着，[motive] 就永久闭嘴。
  const dr = drowsinessOf(s, now, o);
  const inWakeWindow = s.state === 'waking' && s.wakeUntil && now < s.wakeUntil;
  const forcedNap = s.state !== 'sleep' && Number(s.highDebtSince) > 0
    && (now - Number(s.highDebtSince)) >= o.forceSleepAfterMs
    && Number(o.quietForMs) >= o.forceSleepQuietMs;
  if (s.state !== 'sleep' && (forcedNap || (!inWakeWindow && dr >= o.autoSleepDrowsy))) {
    s.state = 'sleep';
    s.sleepSince = now;
    s.sleepOrigin = forcedNap ? 'force' : 'auto';
    s.stateChanged = now;
    events.push({ type: 'auto_sleep', drowsy: +dr.toFixed(3), debt: +s.debt.toFixed(3), origin: s.sleepOrigin });
  }

  // 跨天：drift 判定（连续偏离理想就寝超 2h 的天数；只计数，供反思素材，不强制）
  const day = d.toISOString().slice(0, 10);
  if (s.driftCheckedDay && s.driftCheckedDay !== day) {
    const bedToday = currentBedAt(s, o);
    const dev = Math.abs(((bedToday - o.idealBedMin + 2160) % 1440) - 720);
    s.driftDays = dev > o.driftLimitMin ? s.driftDays + 1 : 0;
    s.driftCheckedDay = day;
    s.sleepNotes = 0;
    s.activeAfterSleep = 0;
    events.push({ type: 'day_rollover', driftDays: s.driftDays });
  }
  if (!s.driftCheckedDay) s.driftCheckedDay = day;
  s.at = now;
  return { state: s, events };
}

function minutesOf(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/** 状态迁移（活动层，纯函数） */
export function transition(state, event, now = Date.now(), cfg = {}) {
  const o = { ...DEFAULTS, ...(cfg ?? {}) };
  const s = { ...state };
  const changed = () => { s.stateChanged = now; };
  switch (event.type) {
    case 'sleep_claimed': { // 她声明睡觉（有代价：自主唤醒被抑制）
      s.state = 'sleep';
      s.sleepSince = now;
      s.sleepOrigin = 'declared';
      s.sleepNotes += 1;
      s.wakeUntil = 0;
      changed();
      break;
    }
    case 'late_sleep_claimed': { // "今晚睡晚"：抬高当前债基线（睡晚=少还债）
      s.debt = clamp01(s.debt + 0.08);
      break;
    }
    case 'incoming': { // 他发消息：被叫醒（mizuse：45 分钟窗口保持 waking）
      if (s.state === 'sleep') {
        const hours = s.sleepSince ? (now - s.sleepSince) / 3600000 : 0;
        if (s.sleepSince && hours >= 0.5) {
          s.sleepLog.push({ startMin: minutesOf(s.sleepSince), endMin: minutesOf(now), hours: +hours.toFixed(2), ts: now });
          s.sleepLog = s.sleepLog.slice(-30);
        }
        // [SLEEP-SPEC] 睡够的时间折现成清醒资本：醒来的那一刻按已睡小时再消一小截困
        // （physTick 逐 tick 还债之外的一次性"醒来了"消困，封顶 0.15，短睡不白给）
        s.debt = clamp01(s.debt - Math.max(0, Math.min(0.15, hours * 0.05))); // 时钟异常导致 hours<0 时不反涨债
        s.state = 'waking';
        s.sleepSince = null;
        s.sleepOrigin = null;
        s.wakeUntil = now + o.wakeWindowMs;
        changed();
      }
      if (event.fromSleep && s.sleepNotes > 0) s.activeAfterSleep += 1;
      break;
    }
    case 'activity': { // handoff / 手机操作 / 她的自主轮
      if (s.state === 'sleep' && s.sleepSince && now - s.sleepSince < o.wakeWindowMs * 2) {
        s.activeAfterSleep += 1; // P2：说睡了又玩
      }
      s.state = 'active';
      s.wakeUntil = 0;
      changed();
      break;
    }
    case 'idle_check': {
      if (s.state === 'active' && now - s.stateChanged > o.idleAfterMs) {
        s.state = 'idle';
        changed();
      }
      break;
    }
    default:
      break;
  }
  s.at = now;
  return s;
}

/** 自主唤醒门（P1 代价）：睡觉中 → 不发起她自己的 turn；被唤醒窗口内除外 */
export function mayOwnWake(state, now = Date.now()) {
  if (!state || state.enabled === false) return true;
  if (state.state === 'sleep') {
    if (now < (state.wakeUntil || 0)) return true;
    return false;
  }
  return true;
}

// 时间段的"人话"（借 mizuse 的时间段规则：别把凌晨当早晨、别把深夜当白天）
export function periodOf(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h >= 0 && h < 4) return { period: '凌晨', hint: '现在是凌晨，困不困、睡不睡你自己说了算；别说"早上好""刚醒"。' };
  if (h < 6) return { period: '清晨', hint: '天刚亮，人还没完全醒。别用"深夜""熬夜"这类说法。' };
  if (h < 9) return { period: '早上', hint: '早上的事，说"昨晚"之前想清楚。' };
  if (h < 12) return { period: '上午', hint: '白天——别冒出"半夜""深夜"这种说法。' };
  if (h < 14) return { period: '中午', hint: '午饭前后。' };
  if (h < 18) return { period: '下午', hint: '白天——别冒出"半夜""深夜"这种说法。' };
  if (h < 21) return { period: '傍晚', hint: '快晚上了。' };
  if (h < 23) return { period: '晚上', hint: '夜里了，想安静就安静，想聊就聊。' };
  return { period: '深夜', hint: '可以自然带时间感，但别反复提"这么晚了"。' };
}

/** 给她的【现在几点】行（时间段语义 + 星期），也是全 prompt 唯一的"当前时间"来源 */
export function renderTimeLine(now = Date.now()) {
  const d = new Date(now);
  const p = periodOf(now);
  const hm = d.toLocaleTimeString('sv-SE').slice(0, 5);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  // [TIME-ONCE] 合并：以前这里和 withSlangContext 各出一条时间行，现在只留这一条（带日期+星期+时段+提示）。
  return `【当前时间】${date} ${hm}（星期${wd}，${p.period}）。${p.hint}`;
}

/** 唤醒 prompt 注入的一行【你现在的状态】（活动 + 生理；时间行由 renderTimeLine 单独给） */
export function renderLifeLine(state, now = Date.now(), cfg = {}) {
  // [TIME-ONCE] 时间行只在 renderTimeLine 出一处；这里不再重复，也不再把"隔夜"写成 720 分钟。
  if (!state || state.enabled === false) return '';
  const dr = drowsinessOf(state, now, cfg);
  const body =
    dr >= 0.8 ? `身体很困（${Math.round(dr * 100)}%），眼皮在打架` :
    dr >= 0.55 ? `有点犯困（${Math.round(dr * 100)}%）` :
    dr >= 0.3 ? `精力还行（${Math.round(dr * 100)}% 的困意底噪）` : '';
  const debtNote = state.debt >= 0.5 ? '，欠的睡眠债还没还清' : '';
  const tail = body ? ' ' + body + debtNote : '';
  switch (state.state) {
    case 'sleep': {
      const gap = state.sleepSince ? humanizeGap(now - state.sleepSince) : '';
      const how = state.sleepOrigin === 'auto' ? '你之前困得睡着了' : '你之前说自己睡了';
      return `【你现在的状态】${how}${gap ? `（${gap}）` : ''}。有人来找你——醒不醒、回不回，你自己定。${tail}`;
    }
    case 'waking': {
      const left = Math.max(0, Math.round(((state.wakeUntil || 0) - now) / 60000));
      return `【你现在的状态】你刚被叫醒（约 ${left} 分钟的清醒窗口）。${tail}`;
    }
    case 'active': {
      const gap = humanizeGap(now - state.stateChanged);
      return `【你现在的状态】上次有动作是${gap ? ` ${gap}` : '刚刚'}。${tail}`;
    }
    case 'idle':
    default: {
      const dur = humanizeDuration(now - state.stateChanged);
      return `【你现在的状态】你闲了${dur ? ` ${dur}` : '一会儿'}。${tail}`;
    }
  }
}

/** 反思喂料（P2）：一句话 */
export function renderReflectLine(state, now = Date.now()) {
  if (!state || state.enabled === false) return '';
  const bits = [];
  if (state.sleepNotes > 0) bits.push(`今天你有 ${state.sleepNotes} 次说到"歇/收尾"`);
  if (state.activeAfterSleep > 0) bits.push(`其中 ${state.activeAfterSleep} 次说完又在动`);
  if (state.driftDays > 0) bits.push(`你的作息已经连续 ${state.driftDays} 天偏离 23:10 两小时以上（事实，你怎么处理自己决定）`);
  if (!bits.length) return '';
  return '【生活状态】' + bits.join('；') + '。';
}
