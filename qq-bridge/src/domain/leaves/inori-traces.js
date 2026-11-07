// inori-traces.js · 经验池（成功和失败的轨迹都存，失败也是数据）
//
// 参照 ExpeL：经验池里既要有成功的轨迹（作为 few-shot 范例），
// 也要有失败的轨迹（用来对比出"哪里错了"）。只存成功会让她反复踩同一个坑。
//
// 存储：data/traces/<YYYY-MM-DD>.jsonl，一行一条，按天分文件（便于按天统计/清理）
// 零依赖纯函数 + 轻量落盘。
import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  dir: projectPath('data', 'traces'),
  maxPerDay: 200,
};

const day = (d = new Date()) => d.toLocaleDateString('sv-SE');

function fileFor(date, dir = DEFAULTS.dir) {
  return path.join(dir, `${date}.jsonl`);
}

/**
 * 记一条轨迹。
 * @param {{goal:string, steps?:Array, result:'success'|'fail', error?:string, note?:string, scope?:string, screenshot?:string}} rec
 */
export function append(rec, opts = {}) {
  const dir = opts.dir || DEFAULTS.dir;
  const now = new Date();
  const d = day(now);
  const entry = {
    at: now.toISOString(),
    day: d,
    scope: String(rec.scope ?? 'private'),
    goal: String(rec.goal ?? '').slice(0, 200),
    steps: Array.isArray(rec.steps) ? rec.steps.slice(0, 60) : [],
    result: rec.result === 'success' ? 'success' : 'fail',
    error: String(rec.error ?? '').slice(0, 300),
    note: String(rec.note ?? '').slice(0, 300),
    screenshot: rec.screenshot ? String(rec.screenshot).slice(0, 300) : '',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fileFor(d, dir), JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  } catch {
    return null;
  }
}

/** 读某天的轨迹（默认今天） */
export function load(date = day(), opts = {}) {
  const dir = opts.dir || DEFAULTS.dir;
  try {
    return fs.readFileSync(fileFor(date, dir), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 最近 N 条（跨天回溯，最多看 7 天） */
export function recent(n = 10, opts = {}) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < 7 && out.length < n; i++) {
    const date = new Date(d.getTime() - i * 86400000).toLocaleDateString('sv-SE');
    const rows = load(date, opts);
    out.unshift(...rows);
    if (out.length >= n) break;
  }
  return out.slice(-n);
}

/**
 * 同类目标的失败史：做同一件事前先看看以前卡在哪。
 * 只做字面包含匹配（不做向量），找不到就返回空数组，不硬猜。
 */
export function priorFailures(query, { dir = DEFAULTS.dir, limit = 5 } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!q) return [];
  return recent(300, { dir })
    .filter((r) => r && r.result !== 'success' && String(r.goal || '').includes(q))
    .slice(-Math.max(1, Number(limit) || 5));
}

/** 失败率统计（给"她有没有在进步"用的客观数） */
export function stats(opts = {}) {
  const rows = recent(200, opts);
  const success = rows.filter((r) => r.result === 'success').length;
  const fail = rows.length - success;
  return {
    total: rows.length,
    success,
    fail,
    successRate: rows.length ? Number((success / rows.length).toFixed(3)) : null,
  };
}
