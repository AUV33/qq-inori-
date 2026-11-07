// inori-self-trend.js · 自我认知趋势（近 N 天 vs 上一个 N 天）
//
// 自我档案只给"现在是什么样"，没给"我最近在变吗"。
// 数据源：style-profile.jsonl（每次测得场合/自己/判定）、action-log.jsonl（turn/主动/busy_stash）、lessons.jsonl（经验条数）。
// 零 LLM、只读；没有数据返回 null，不硬造。
import fs from 'node:fs';
import { readJsonl } from './jsonl.mjs';

const DAY = 24 * 3600 * 1000;

export function readJsonlSafe(file) { return readJsonl(file); }

const ts = (row) => {
  const t = Date.parse(String(row?.at || row?.ts || row?.time || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};

function windowRows(rows, from, to) {
  return rows.filter((r) => { const t = ts(r); return t != null && t >= from && t < to; });
}

function avg(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function profileSummary(rows) {
  if (!rows.length) return null;
  return {
    avgLen: avg(rows.map((r) => Number(r?.mine?.avgLen))),
    shortRatio: avg(rows.map((r) => Number(r?.mine?.shortRatio))),
    gap: avg(rows.map((r) => Number(r?.gap))),
    ok: rows.filter((r) => r?.verdict === 'ok').length,
    tooLong: rows.filter((r) => r?.verdict === 'too_long').length,
    tooShort: rows.filter((r) => r?.verdict === 'too_short').length,
  };
}

function actionSummary(rows) {
  const turns = rows.filter((r) => r.t === 'turn').length;
  const proactive = rows.filter((r) => ['probability', 'selfWake', 'joinTopic', 'freeTick', 'proactiveCheck'].includes(String(r.trigger || ''))).length;
  const stash = rows.filter((r) => r.t === 'busy_stash').length;
  return { turns, proactive, stash };
}

export function summarizeSelfTrend({ styleRows = [], actionRows = [], lessonsRows = [], now = Date.now(), days = 7 } = {}) {
  const span = days * DAY;
  const curFrom = now - span;
  const prevFrom = now - 2 * span;
  const curStyle = windowRows(styleRows, curFrom, now);
  const prevStyle = windowRows(styleRows, prevFrom, curFrom);
  const curAction = windowRows(actionRows, curFrom, now);
  const prevAction = windowRows(actionRows, prevFrom, curFrom);
  const curLessons = windowRows(lessonsRows, curFrom, now).length;
  const prevLessons = windowRows(lessonsRows, prevFrom, curFrom).length;
  const current = { style: profileSummary(curStyle), action: actionSummary(curAction), lessons: curLessons };
  const previous = { style: profileSummary(prevStyle), action: actionSummary(prevAction), lessons: prevLessons };
  const hasData = !!(current.style || previous.style || curAction.length || prevAction.length || curLessons || prevLessons);
  return { days, current, previous, hasData };
}

const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : '—');

export function renderSelfTrend(summary) {
  if (!summary || !summary.hasData) return null;
  const c = summary.current; const p = summary.previous;
  const parts = [];
  if (c.style && p.style) {
    const da = (c.style.avgLen ?? 0) - (p.style.avgLen ?? 0);
    parts.push(`说话字数 ${fmt(p.style.avgLen)}→${fmt(c.style.avgLen)}（${da >= 0 ? '+' : ''}${fmt(da)}）`);
    const ds = ((c.style.shortRatio ?? 0) - (p.style.shortRatio ?? 0)) * 100;
    parts.push(`短句占比 ${fmt((p.style.shortRatio ?? 0) * 100, 0)}%→${fmt((c.style.shortRatio ?? 0) * 100, 0)}%（${ds >= 0 ? '+' : ''}${fmt(ds, 0)}）`);
    parts.push(`场合判定 ok ${c.style.ok} / 话太长 ${c.style.tooLong} / 话太短 ${c.style.tooShort}`);
  } else if (c.style) {
    parts.push(`说话字数 ${fmt(c.style.avgLen)}，短句占比 ${fmt((c.style.shortRatio ?? 0) * 100, 0)}%，场合判定 ok ${c.style.ok}`);
  }
  if (c.action.turns || p.action.turns) parts.push(`回合 ${p.action.turns}→${c.action.turns}`);
  if (c.action.proactive || p.action.proactive) parts.push(`主动开口 ${p.action.proactive}→${c.action.proactive}`);
  if (c.action.stash || p.action.stash) parts.push(`会话繁忙暂存 ${p.action.stash}→${c.action.stash}`);
  if (c.lessons || p.lessons) parts.push(`新经验 +${c.lessons}（上周 +${p.lessons}）`);
  if (!parts.length) return null;
  return `我最近（近 ${summary.days} 天 vs 上一周）：${parts.join('；')}。`;
}
