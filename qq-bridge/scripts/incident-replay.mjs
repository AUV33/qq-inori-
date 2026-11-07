#!/usr/bin/env node
// incident-replay.mjs · 事故可回放：在给定时间点周围重建日志时间线（E1 / R8「事故可回放」）
//
// 和 aliveness-report 对称——它把日志"算成指数"，这里把日志"按时间重放"用于诊断。
// 只读 data/ 下的既有日志，不写、不调模型。窗口 [around-window, around+window] 内
// 的 life-log / action-log / floor-decisions / lessons / evolution 合并排序后返回。
//
// 用法：
//   node scripts/incident-replay.mjs --around 2026-11-03T12:00:00Z --window 30m
//   node scripts/incident-replay.mjs --around 1793772000000 --window 1h --json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
import { obsPaths } from './lib/observability-paths.mjs';

export const INCIDENT_REPLAY_VERSION = 1;

const DEFAULT_SOURCES = ['life-log', 'action-log', 'floor', 'lessons', 'evolution'];

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

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function listDir(dir, pattern) {
  try { return fs.readdirSync(dir).filter((f) => pattern.test(f)); } catch { return []; }
}

function kindOf(source, row) {
  if (source === 'life-log') return String(row.type || row.kind || 'event');
  if (source === 'action-log') return 'turn:' + String(row.t || row.kind || '?');
  if (source === 'floor') return row.directed === true ? 'floor:directed' : 'floor';
  if (source === 'lessons') return 'lesson';
  if (source === 'evolution') return 'evolution:' + String(row.kind || 'snapshot');
  return source;
}

/** 合并所有来源日志为 {source, at, raw} 数组（不裁剪窗口）。 */
export function gatherLogs(root, { sources = DEFAULT_SOURCES } = {}) {
  const out = [];
  const P = obsPaths(root);
  if (sources.includes('life-log')) {
    for (const file of listDir(P.lifeLog, /^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
      for (const row of readJsonl(path.join(P.lifeLog, file))) out.push({ source: 'life-log', at: tsOf(row), raw: row });
    }
  }
  if (sources.includes('action-log')) {
    for (const row of readJsonl(P.actionLog)) out.push({ source: 'action-log', at: tsOf(row), raw: row });
  }
  if (sources.includes('floor')) {
    for (const row of readJsonl(P.floorDecisions)) out.push({ source: 'floor', at: tsOf(row), raw: row });
  }
  if (sources.includes('lessons')) {
    for (const row of readJsonl(P.lessons)) out.push({ source: 'lessons', at: tsOf(row), raw: row });
  }
  if (sources.includes('evolution')) {
    for (const row of readJsonl(P.evolution)) out.push({ source: 'evolution', at: tsOf(row), raw: row });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 在 around 周围 windowMs 窗口内重建时间线。
 * @param {{root?:string, around:number|string, windowMs?:number, sources?:string[]}} opts
 */
export function replayIncident(opts) {
  const root = path.resolve(opts.root || PROJECT_ROOT);
  let around = typeof opts.around === 'number' ? opts.around : Date.parse(String(opts.around));
  if (!Number.isFinite(around)) around = Date.now();
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 30 * 60 * 1000;

  const lo = around - windowMs;
  const hi = around + windowMs;
  const all = gatherLogs(root, { sources: opts.sources });
  const events = all
    .filter((e) => e.at >= lo && e.at <= hi)
    .map((e) => ({
      at: e.at,
      atISO: new Date(e.at).toISOString(),
      source: e.source,
      kind: kindOf(e.source, e.raw),
      raw: e.raw,
    }));

  const counts = {};
  const byKind = {};
  const errors = [];
  for (const e of events) {
    counts[e.source] = (counts[e.source] || 0) + 1;
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const isErr = e.kind === 'error.observed' || e.raw?.level === 'error' || e.raw?.error === true;
    if (isErr) errors.push({ at: e.at, atISO: e.atISO, source: e.source, kind: e.kind, raw: e.raw });
  }

  return {
    v: INCIDENT_REPLAY_VERSION,
    around,
    aroundISO: new Date(around).toISOString(),
    windowMs,
    count: events.length,
    events,
    counts,
    byKind,
    errors,
  };
}

export function renderReplay(report) {
  if (!report.count) return `窗口 ${report.windowMs / 60000}m 内无事件（around ${report.aroundISO}）`;
  const lines = [`事故回放 · around ${report.aroundISO} · 窗口 ${report.windowMs / 60000}m · 共 ${report.count} 条`];
  lines.push('时间 | 来源 | 类型');
  lines.push('---|---|---');
  for (const e of report.events) lines.push(`${e.atISO} | ${e.source} | ${e.kind}`);
  if (report.errors.length) {
    lines.push('');
    lines.push(`异常 ${report.errors.length} 条：`);
    for (const er of report.errors) lines.push(`- ${er.atISO} ${er.source} ${er.kind}`);
  }
  return lines.join('\n');
}

// --around 支持 "30m" / "1h" / 纯毫秒 / ISO
function parseWindow(arg) {
  if (typeof arg === 'number') return arg;
  const s = String(arg || '').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
    return n * unit;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 30 * 60000;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ai = args.indexOf('--around');
  const around = ai >= 0 ? args[ai + 1] : Date.now();
  const wi = args.indexOf('--window');
  const windowMs = wi >= 0 ? parseWindow(args[wi + 1]) : 30 * 60000;
  const json = args.includes('--json');
  const root = (() => { const ri = args.indexOf('--root'); return ri >= 0 ? args[ri + 1] : PROJECT_ROOT; })();
  const report = replayIncident({ root, around, windowMs });
  console.log(json ? JSON.stringify(report, null, 1) : renderReplay(report));
}
