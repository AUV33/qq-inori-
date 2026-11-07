// inori-actionlog.js · 自主行动日志（纯观察，零约束）
//
// 行为账（inori-behavior-ledger）回答"她今天做了什么"（手机/视频/经验…）；
// 这份日志回答"她的行动是怎么发生的"——每个自主行动决策点一条事实：
//   · 回合结果：系统为什么叫醒她（trigger）、她做了什么（sent/wrote_not_sent/closed/no_action）
//   · 系统推她的：proactive_check（定时器主动机会）、diary（定时日记）
//   · 阀门拦她的：wake_skip（限流跳过）、busy_stash（会话繁忙暂存）、quiet_clamp（静默被夹）
//   · 她自己的选择：wake_config（她亲手设的潜水/唤醒条件，含 her/console 来源）
//
// 纪律：
//   1. 只写 data/state/action-log.jsonl，任何写失败都不影响桥接主流程（try/catch 吞掉）。
//   2. 不做任何行为改变：不拦截、不钳制、不提示、不重排——挂接点只调用 logAction 一行。
//   3. 文件超过 512KB 轮转为 .old（覆盖旧的），永不无限增长。
//   4. 不存她的发言内容（只存字数级计数与触发器），隐私与体积都可控。

import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';

const DEFAULT_FILE = stateDataPath('action-log.jsonl');
const ROTATE_BYTES = 512 * 1024;

let activeFile = DEFAULT_FILE;
let lastSize = -1;

/** 测试/审计 harness 专用：把日志指到临时目录（同一模块实例的行为账/报表随之改读该文件）。生产路径不调。 */
export function setLogFile(p) {
  activeFile = p || DEFAULT_FILE;
  lastSize = -1;
}

/**
 * 判断这条行动是谁选的：她 / 主人 / 系统。
 * 只用于行动日志的 chosenBy 字段，不参与任何调度。
 */
export function inferChosenBy(evt = {}) {
  if (evt.chosenBy) return String(evt.chosenBy);
  if (evt.by === 'her') return 'her';
  if (evt.by === 'console' || evt.by === 'owner') return 'owner';
  const trigger = String(evt.trigger || '').split(':')[0];
  if (['own-life', 'free-tick', 'boredom', 'curiosity', 'practice'].includes(trigger)) return 'her';
  return 'system';
}

/**
 * 记一条自主行动事件。纯追加，永不抛出。
 * evt: { t: 'turn'|'proactive_check'|'wake_skip'|'busy_stash'|'quiet_clamp'|'wake_config'|'diary',
 *        key?, trigger?, outcome?, ...任意事实字段 }
 */
export function logAction(evt, file = activeFile) {
  try {
    const rec = { ts: new Date().toISOString(), chosenBy: inferChosenBy(evt), ...evt };
    const line = JSON.stringify(rec) + '\n';
    let size = file === activeFile && lastSize >= 0 ? lastSize : safeSize(file);
    if (size > ROTATE_BYTES) {
      try { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, '', 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-actionlog.js:56'); }
      size = 0;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
    if (file === activeFile) lastSize = size + line.length;
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-actionlog.js:62'); }
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readAll(file = activeFile) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (file === activeFile) {
      try {
        const oldLines = fs.readFileSync(`${file}.old`, 'utf8').split('\n').filter(Boolean);
        for (const l of oldLines) { try { recs.push(JSON.parse(l)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-actionlog.js:76'); } }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-actionlog.js:77'); }
    }
    return recs;
  } catch { return []; }
}

function sameDay(ts, dayStr) {
  const t = Date.parse(ts);
  return Number.isFinite(t) && new Date(t).toLocaleDateString('sv-SE') === dayStr;
}

/** 当天行动日志汇总（事实，不评价；喂报表脚本与夜间行为账）。 */
export function summarizeActionLog({ day, now = new Date(), file = activeFile } = {}) {
  const dayStr = day || now.toLocaleDateString('sv-SE');
  const recs = readAll(file).filter((r) => r?.ts && sameDay(r.ts, dayStr));
  if (!recs.length) return { n: 0, line: '', detail: emptyDetail() };
  const by = (t) => recs.filter((r) => r.t === t);
  const turns = by('turn');
  const sent = turns.filter((r) => r.outcome === 'sent').length;
  const wroteNotSent = turns.filter((r) => r.outcome === 'wrote_not_sent').length;
  const closed = turns.filter((r) => r.outcome === 'closed').length;
  const noAction = turns.filter((r) => r.outcome === 'no_action').length;
  // 系统推的（定时器/日程）与消息反应（她对外界信号的应答）；按冒号前基名匹配（keyword:小鲸鱼 → keyword）
  const SYS = new Set(['proactiveCheck', 'timeout', 'replyCheck', 'probability', 'own-life', 'reflection', 'reflection-retry', 'diary', 'reminder', 'chase', 'bootstrap']);
  const sysTriggers = turns.filter((r) => SYS.has(String(r.trigger || '').split(':')[0])).length;
  const reactTriggers = turns.length - sysTriggers;
  const skips = by('wake_skip').length;
  const stashes = by('busy_stash').length;
  const clamps = by('quiet_clamp').length;
  const dives = by('wake_config').filter((r) => r.by === 'her').length;
  const divesConsole = by('wake_config').filter((r) => r.by === 'console').length;
  const diaries = by('diary').length;
  const triggers = {};
  for (const r of turns) {
    const k = r.trigger || 'unknown';
    triggers[k] = (triggers[k] || 0) + 1;
  }
  const parts = [];
  if (turns.length) {
    parts.push(`回合 ${turns.length}（开口 ${sent} · 写没发 ${wroteNotSent} · 安静收尾 ${closed} · 没动 ${noAction}｜系统叫醒 ${sysTriggers} · 消息反应 ${reactTriggers}）`);
  }
  if (skips) parts.push(`限流跳过 ${skips}`);
  if (stashes) parts.push(`繁忙暂存 ${stashes}`);
  if (clamps) parts.push(`静默被夹 ${clamps}`);
  if (dives || divesConsole) parts.push(`她设潜水 ${dives} 次${divesConsole ? `（控制台 ${divesConsole}）` : ''}`);
  if (diaries) parts.push(`日记 ${diaries}`);
  const detail = emptyDetail({
    turns: turns.length, sent, wroteNotSent, closed, noAction,
    sysTriggers, reactTriggers, skips, stashes, clamps, dives, divesConsole, diaries,
  });
  detail.triggers = triggers;
  return { n: recs.length, line: parts.length ? `【自主行动日志】${dayStr}：${parts.join(' · ')}` : '', detail };
}

function emptyDetail(v = {}) {
  return Object.assign({
    turns: 0, sent: 0, wroteNotSent: 0, closed: 0, noAction: 0,
    sysTriggers: 0, reactTriggers: 0, skips: 0, stashes: 0, clamps: 0,
    dives: 0, divesConsole: 0, diaries: 0, triggers: {},
  }, v);
}
