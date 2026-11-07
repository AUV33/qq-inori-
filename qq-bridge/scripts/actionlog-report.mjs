#!/usr/bin/env node
// 自主行动日志报表：node scripts/actionlog-report.mjs [YYYY-MM-DD]
// 回答三问：她做的（开口/收尾/潜水）· 系统推的（定时器叫醒）· 阀门拦的（限流/繁忙/静默夹）
import { summarizeActionLog } from '../src/domain/leaves/inori-actionlog.js';

const day = process.argv[2];
const s = summarizeActionLog({ day });
if (!s.n) {
  console.log(day ? `${day} 暂无行动日志（还没挂上，或当天没有事件）` : '行动日志还是空的');
  process.exit(0);
}
const d = s.detail;
console.log(`# 自主行动日志 ${day || '今天'}（共 ${s.n} 条事件）`);
console.log('');
console.log(`回合 ${d.turns}：开口 ${d.sent} · 写没发 ${d.wroteNotSent} · 安静收尾 ${d.closed} · 没动 ${d.noAction}`);
console.log(`  触发分布：${Object.entries(d.triggers).map(([k, v]) => `${k} ×${v}`).join(' · ') || '—'}`);
console.log(`  系统叫醒 ${d.sysTriggers} / 消息反应 ${d.reactTriggers}${d.turns ? `（推她占比 ${(d.sysTriggers / d.turns).toFixed(2)}）` : ''}`);
console.log(`阀门：限流跳过 ${d.skips} · 繁忙暂存 ${d.stashes} · 静默被夹 ${d.clamps}`);
console.log(`潜水：她亲手设 ${d.dives} 次 · 控制台 ${d.divesConsole} 次 · 日记 ${d.diaries} 篇`);
