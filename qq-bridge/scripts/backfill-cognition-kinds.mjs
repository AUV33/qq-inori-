#!/usr/bin/env node
// 一次性回填：给老认知补 kind（不改正文、不改判定）。
// 只处理 kind 缺失或为 general 的条目；--force 则全部重判。重复跑是幂等的。跑之前自动备份。
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const FILE = `${PROJECT_ROOT}/data/state/cognition.jsonl`;
const force = process.argv.includes('--force');

// 顺序即优先级：先判"跟人有关"，再判"跟操作有关"，最后兜底。
const RULES = [
  [/群|群友|别人|他们|观众|弹幕|附和/, 'about-group'],
  [/他|你|主人|关系|说话|语气|嘴硬/, 'about-him'],
  [/操作|步骤|先试|拖动|命令|脚本|app|软件|手机|界面|机制/i, 'how-to'],
];

const raw = fs.readFileSync(FILE, 'utf8').trim();
const rows = raw ? raw.split('\n').filter(Boolean) : [];
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${FILE}.bak-kind-${stamp}`;
fs.copyFileSync(FILE, backup);

let changed = 0;
const out = rows.map((line) => {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (!force && e.kind && e.kind !== 'general') return JSON.stringify(e);
  const text = `${e.text || ''} ${e.concept || ''} ${e.gist || ''}`;
  const hit = RULES.find(([re]) => re.test(text));
  const next = hit ? hit[1] : 'general';
  if (next !== e.kind) changed += 1;
  e.kind = next;
  return JSON.stringify(e);
});

fs.writeFileSync(FILE, out.join('\n') + '\n', 'utf8');
console.log(`entries=${rows.length} changed=${changed} backup=${backup}`);
for (const line of out) {
  const e = JSON.parse(line);
  console.log(`  [${e.kind}] ${String(e.text).slice(0, 50)}`);
}
