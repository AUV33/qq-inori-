#!/usr/bin/env node
// backup-state.mjs · 学习/任务相关状态的最小备份（只复制，不删除）
//
// 不备份整个 data/state（太大，且含日志），只备份“丢了会让她忘记自己在做什么”的文件。
// 用法：
//   node scripts/backup-state.mjs --dry-run
//   node scripts/backup-state.mjs
// 输出：state/backups/<YYYYMMDD-HHmmss>/{files...,manifest.json}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const DATA = path.resolve(ROOT, '..', 'data', 'state');
const dryRun = process.argv.includes('--dry-run');

const FILES = [
  'task-ledger.jsonl',
  'task-pool.json',
  'works.json',
  'goals.json',
  'intentions.json',
  'outcomes.jsonl',
  'skills.json',
  'lessons.jsonl',
  'learning-items.json',
  'practice-sessions.jsonl',
  'skill-drafts.json',
  'session-notes.json',
  'learning-trend.jsonl',
  'learning-report.md',
];

function sourceFor(name) {
  for (const dir of [DATA, STATE]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const target = path.join(STATE, 'backups', stamp);
const manifest = { at: new Date().toISOString(), source: 'backup-state', files: [], missing: [] };
for (const name of FILES) {
  const src = sourceFor(name);
  if (!src) { manifest.missing.push(name); continue; }
  const dst = path.join(target, name);
  manifest.files.push({ name, bytes: fs.statSync(src).size, source: src });
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
if (!dryRun) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}
console.log(`${dryRun ? '[dry-run] ' : ''}备份 ${manifest.files.length} 个文件 → ${target}`);
if (manifest.missing.length) console.log(`跳过不存在：${manifest.missing.join(', ')}`);
