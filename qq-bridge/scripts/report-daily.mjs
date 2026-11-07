// 她今天做了什么（只读汇总）
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = `${PROJECT_ROOT}`;
const STATE = path.join(ROOT, 'data/state');
const OUT = path.join(ROOT, 'data/reports');
fs.mkdirSync(OUT, { recursive: true });
const cut = Date.now() - 24 * 3600 * 1000;
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const readJsonl = (f) => readLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const recent = (rows) => rows.filter((r) => { const t = Date.parse(String(r.at || r.time || '').replace(' ', 'T')); return Number.isFinite(t) && t >= cut; });

const actions = recent(readJsonl(path.join(ROOT, 'qq-bridge/state/qq-activity.log')));
const ledger = recent(readJsonl(path.join(STATE, 'task-ledger.jsonl')));
const lessons = recent(readJsonl(path.join(STATE, 'lessons.jsonl')));
const mem = recent(readJsonl(path.join(ROOT, 'data/memory/memory.jsonl')));
const traces = (() => {
  const dir = path.join(STATE, '..', '..', 'data', 'traces');
  const out = [];
  try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.jsonl')) continue; out.push(...readJsonl(path.join(dir, f))); } } catch {}
  return recent(out);
})();

const byTool = new Map();
for (const a of actions) { const k = a.tool || a.kind || a.type || '?'; byTool.set(k, (byTool.get(k) || 0) + 1); }
const day = new Date().toLocaleDateString('sv-SE');
const md = [
  '# 今天她做了什么（近 24h）',
  '',
  `- 活动日志：${actions.length} 条`,
  `- 任务台账：${ledger.length} 条（${ledger.map((l) => l.status || '').filter(Boolean).slice(0, 8).join(' / ')}）`,
  `- 经验：+我要了？写入记录 ${lessons.length} 条`,
  `- 私聊记忆：+我要了？${mem.length} 条`,
  `- 轨迹：${traces.length} 条`,
  '',
  '## 活动分布',
  ...[...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `- ${k}: ${v}`),
  '',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
].join('\n');
fs.writeFileSync(path.join(OUT, `daily-${day}.md`), md + '\n', 'utf8');
console.log('wrote', path.join(OUT, `daily-${day}.md`));
