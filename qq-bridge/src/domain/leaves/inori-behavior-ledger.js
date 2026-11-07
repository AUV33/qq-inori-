// inori-behavior-ledger.js · 行为账：她今天实际干了什么（喂给夜间反思）
//
// 反思之前没米下锅：只给"几条经验、几条记忆"的数字，她要自己想今天干了啥。
// 这个模块把散落在五处的行为痕迹汇成一行事实——不评价、不替她下结论，只摆账。
//
// 数据源（全只读，缺哪个省哪个，不硬编）：
//   traces/<day>.jsonl      手机上做的操作段（成功/卡住）
//   state/video-watch.json  看过的视频（看完/没看完 + 她的想法）
//   state/lessons.jsonl     今天新增/改过的经验
//   state/slang.json        查过的词（candidate/confirmed）
//   state/tool-calls.jsonl  工具调用次数（文件可能不存在——第一次调用才创建）
//   goals.json              今天接了/划掉的事

import fs from 'node:fs';
import path from 'node:path';
import { summarizeActionLog } from './inori-actionlog.js';
import { STATE_DATA_DIR, projectPath } from '../shared/project-paths.js';
import { readJsonl as readJsonlShared } from './jsonl.mjs';

const D = {
  state: STATE_DATA_DIR,
  traces: projectPath('data', 'traces'),
};

function readJsonl(file) { return readJsonlShared(file); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sameDay(iso, dayStr) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).toLocaleDateString('sv-SE') === dayStr;
}

/**
 * 一行行为账。day 缺省=今天。
 * 例：今天：手机 2 段（1 段卡住）· 看视频 1 条（没看完，想法：转场好看）· 新经验 2 · 查词 1 · 接事 1 · 工具调用 112 次
 */
export function renderBehaviorLedger({ day, dirs = D, now = new Date() } = {}) {
  const dayStr = day || now.toLocaleDateString('sv-SE');
  const st = dirs.state;
  const parts = [];

  // 手机操作段（traces 按天分文件）
  const trows = readJsonl(path.join(dirs.traces, `${dayStr}.jsonl`));
  if (trows.length) {
    const stuck = trows.filter((t) => t.stuck).length;
    parts.push(`手机 ${trows.length} 段操作${stuck ? `（${stuck} 段卡住）` : ''}`);
  }

  // 看过的视频（video-watch 会话日志，exit 才入 log）
  const vw = readJson(path.join(st, 'video-watch.json'));
  const vwToday = (vw?.log ?? []).filter((x) => sameDay(x.ts, dayStr));
  if (vwToday.length) {
    const finished = vwToday.filter((x) => x.total > 0 && x.watched >= x.total).length;
    const withTake = vwToday.filter((x) => x.take).length;
    const mmss = (sec) => `${Math.floor((Number(sec) || 0) / 60)}:${String(Math.floor((Number(sec) || 0) % 60)).padStart(2, '0')}`;
    const desc = vwToday.slice(0, 2).map((x) => `《${String(x.title ?? '').slice(0, 14)}》看到 ${mmss(x.watched)}/${x.total ? mmss(x.total) : '?'}`).join('、');
    parts.push(`看视频 ${vwToday.length} 条（${finished}/${vwToday.length} 看完${withTake ? `，${withTake} 条留了想法` : ''}）${desc ? `：${desc}` : ''}`);
  }

  // 新经验（今天 at/usedAt 落在今天的 lessons）
  const lessons = readJsonl(path.join(st, 'lessons.jsonl'));
  const newLessons = lessons.filter((l) => sameDay(l.at, dayStr)).length;
  if (newLessons) parts.push(`新经验 ${newLessons} 条`);

  // 查过的词（slang 库里今天动过的）
  // [SLANG-SHAPE] 两种历史格式：{entries:[...]} 与裸数组。
  // 旧写法 `readJson(...)?.entries ?? readJson(...)` 对裸数组会拿到 Array.prototype.entries（函数）→ 永远失效。
  const slangRaw = readJson(path.join(st, 'slang.json'));
  const slang = Array.isArray(slangRaw) ? slangRaw : slangRaw?.entries;
  if (Array.isArray(slang) && slang.length) {
    const touched = slang.filter((e) => sameDay(e.updatedAt ?? e.createdAt, dayStr)).length;
    if (touched) parts.push(`查词 ${touched} 个`);
  }

  // 接的事（goals 今天动的）
  const goals = readJson(path.join(st, 'goals.json'));
  const gToday = (Array.isArray(goals) ? goals : goals?.goals ?? [])
    .filter((g) => sameDay(g.at ?? g.createdAt, dayStr)).length;
  if (gToday) parts.push(`事上动了 ${gToday} 处`);

  // 工具调用（文件可能不存在——没调过就 0，正常）
  const calls = readJsonl(path.join(st, 'tool-calls.jsonl')).filter((t) => sameDay(t.ts, dayStr)).length;
  if (calls) parts.push(`工具调用 ${calls} 次`);

  // 自主行动日志（回合/阀门/潜水——事实计数，不评价）
  try {
    const sum = summarizeActionLog({ day: dayStr, now });
    const inner = String(sum.line || '').replace(/^【自主行动日志】\d{4}-\d{2}-\d{2}：/, '');
    if (inner) parts.push(`行动 ${inner}`);
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-behavior-ledger.js:95'); }

  if (!parts.length) return '';
  return `【今天的行为账（事实，不评价）】${dayStr}：${parts.join(' · ')}`;
}
