#!/usr/bin/env node
// social-quality-report.mjs · 用现有日志算“质量信号”，并对齐 C4 策略（离线，只读）
//
// 输入：data/state/floor-decisions.jsonl、action-log.jsonl、data/logs/life-log/*.jsonl
// 输出：漏接率、被接住率、quality-policy 判定（normal/watch/caution/unknown）。
// 不启动服务、不写业务状态；只打印。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDirected } from '../src/domain/mind/engagement-metrics.mjs';
import { decideQualityPolicy } from '../src/domain/mind/quality-policy.mjs';
import { computeCaughtRate } from './aliveness-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export function summarizeQuality({ floor = [], action = [], events = [] } = {}) {
  const missed = classifyDirected(floor, action);
  const caught = computeCaughtRate(events);
  const policy = decideQualityPolicy({
    missedRate: missed.missedRate,
    noTurnRate: missed.noTurnRate,
    turnOtherRate: missed.turnOtherRate,
    caughtRate: caught.rate,
    samples: missed.directedWakes,
    noData: missed.noData,
  });
  return { missed, caught, policy };
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readLifeLog(days = 7) {
  const dir = path.join(ROOT, 'data', 'logs', 'life-log');
  const out = [];
  try {
    const names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days);
    for (const name of names) out.push(...readJsonl(path.join(dir, name)));
  } catch { /* no log */ }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) || 7 : 7;
  const floor = readJsonl(path.join(ROOT, 'data', 'state', 'floor-decisions.jsonl'));
  const action = readJsonl(path.join(ROOT, 'data', 'state', 'action-log.jsonl'));
  const events = readLifeLog(days);
  const r = summarizeQuality({ floor, action, events });
  console.log(JSON.stringify({
    days,
    floorRows: floor.length,
    actionRows: action.length,
    eventRows: events.length,
    missed: r.missed,
    caught: r.caught,
    policy: r.policy,
  }, null, 1));
}
