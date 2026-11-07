// verify-agency.mjs · 主观能动性验证：机制接线 + 实际使用证据（可机检）
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const Q = `${PROJECT_ROOT}`;
const S = path.join(Q, 'qq-bridge/state');
const D = path.join(Q, 'data/state');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const json = (p) => { try { return JSON.parse(read(p).replace(/^\uFEFF/, '')); } catch { return null; } };
const count = (p) => read(p).split('\n').filter(Boolean).length;

// 1) 日志里她的「自主动作」计数（最近两份日志）
const logs = [read(path.join(S, 'bridge.log')), read(path.join(S, 'bridge.log.1')), read(path.join(S, 'bridge.log.2'))].join('\n');
const byReason = {};
for (const m of logs.matchAll(/唤醒\s+(\S+?)（([a-zA-Z]+)[^）]*）/g)) byReason[m[2]] = (byReason[m[2]] || 0) + 1;
const cnt = (re) => (logs.match(re) || []).length;

console.log('=== A. 机制接线（工具在她手里 / 定时器在跑） ===');
const toolList = json(path.join(S, 'tool-list-snapshot.json'));
console.log('（工具面以 01:0x dsh-v2-wait 实拍清单为准，见下）');

console.log('\n=== B. 实际使用证据（日志 + 状态文件） ===');
const rows = [
  ['own-life 自主轮', cnt(/\[own-life\]/g) + cnt(/\bown-life\b/g)],
  ['proactiveCheck 主动机会唤醒', cnt(/proactiveCheck/g)],
  ['joinTopic 活跃群插话判定', cnt(/\[join\]/g)],
  ['continueChat 延续对话', cnt(/continueChat/g)],
  ['selfWake 自唤醒', cnt(/selfWake/g)],
  ['wish 想做的事', cnt(/\[wish|wishLine|qq_wish/g)],
  ['curiosity 好奇清单', cnt(/curiosity/g)],
  ['workshop 工坊', cnt(/workshop/g)],
  ['phone 手机操作', cnt(/phone_look|phone_/g)],
  ['video 看视频', cnt(/video_feed|video_watch|watch_video/g)],
  ['qzone 说说', cnt(/qzone/g)],
  ['handoff 派活', cnt(/\[handoff\]|派活告知/g)],
  ['slang_judge 黑话终审', cnt(/slang-judge|slang_judge/g)],
  ['group-admin 群管理', cnt(/\[group-admin\]/g)],
];
for (const [k, v] of rows) console.log(`${String(v).padStart(5)}  ${k}`);

console.log('\n=== C. 状态文件里的「她自己的东西」 ===');
const files = [
  ['她的念头 thoughts.jsonl', path.join(D, 'thoughts.jsonl')],
  ['她的经验 lessons.jsonl', path.join(D, 'lessons.jsonl')],
  ['行动日志 action-log.jsonl', path.join(S, 'action-log.jsonl')],
  ['自省 ruminations.jsonl', path.join(D, 'ruminations.jsonl')],
  ['任务台账 task-ledger.jsonl', path.join(D, 'task-ledger.jsonl')],
  ['墙变更 wall-log.jsonl', path.join(S, 'wall-log.jsonl')],
  ['门调参 gate-tune-log.jsonl', path.join(S, 'gate-tune-log.jsonl')],
  ['工具边界 tool-log.jsonl', path.join(S, 'tool-log.jsonl')],
  ['日记 diary.jsonl', path.join(Q, 'data/diary/diary.jsonl')],
];
for (const [name, p] of files) console.log(`${String(count(p)).padStart(5)}  ${name}  ${fs.existsSync(p) ? '' : '(缺失)'}`);

const wish = json(path.join(D, 'wish.json')) ?? json(path.join(S, 'wish.json'));
console.log('\nwish.json:', JSON.stringify(wish)?.slice(0, 200) ?? '(无)');
const rhythm = json(path.join(S, 'own-life-rhythm.json'));
console.log('own-life-rhythm.json:', JSON.stringify(rhythm)?.slice(0, 200) ?? '(无)');
const curiosity = json(path.join(D, 'curiosity.json')) ?? json(path.join(S, 'curiosity.json'));
console.log('curiosity.json:', JSON.stringify(curiosity)?.slice(0, 200) ?? '(无)');
const life = json(path.join(D, 'life.json')) ?? json(path.join(S, 'life.json'));
console.log('life.json:', JSON.stringify(life)?.slice(0, 220) ?? '(无)');

const ws = path.join(Q, 'data/workshop');
let wsFiles = [];
try { wsFiles = fs.readdirSync(ws).filter((f) => !f.startsWith('.')); } catch {}
console.log('\n工坊文件:', wsFiles.length ? wsFiles.join(', ') : '(空)');

console.log('\n=== D. 唤醒原因分布（日志） ===');
const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
console.log(sorted.map(([k, v]) => `${k}:${v}`).join('  ') || '(无)');

// 她的发言次数 vs 唤醒次数（主动性粗指标：非被叫醒的开口）
const toolSends = cnt(/工具统一发送/g);
console.log(`\n工具统一发送次数：${toolSends}`);
