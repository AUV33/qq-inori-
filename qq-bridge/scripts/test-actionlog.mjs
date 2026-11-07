import { readBridgeSource } from './lib/bridge-source.mjs';
// 自主行动日志（inori-actionlog）回归锁：
//   1) 追加/轮转/汇总的纯函数行为（临时文件，不碰她的真实日志）
//   2) bridge.js 挂接纪律：logAction 只允许"裸调用 + 注释"，绝不允许出现在条件/返回值里
//      （挂进去一个 if (logAction(...)) 或把结果写回状态，就是变相约束她——这条锁就是防这个的）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logAction, summarizeActionLog } from '../src/domain/leaves/inori-actionlog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actionlog-'));
const file = path.join(tmp, 'action-log.jsonl');

console.log('## 追加与解析');
logAction({ t: 'turn', key: 'group:x', trigger: 'proactiveCheck', outcome: 'sent' }, file);
logAction({ t: 'wake_skip', key: 'group:x', trigger: 'poke' }, file);
logAction({ t: 'wake_config', key: 'group:x', by: 'her', mode: 'diving', infinite: false, sleepSec: 3600 }, file);
logAction({ t: 'wake_config', key: 'group:x', by: 'console', mode: 'active' }, file);
logAction({ t: 'diary', day: '2026-10-25', made: true }, file);
logAction({ t: 'proactive_check', key: 'group:x', prob: 0.42 }, file);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
ok(lines.length === 6, '6 条事件全部落盘且可解析');
ok(lines.every((r) => typeof r.ts === 'string' && r.ts.length > 0), '每条都有 ISO 时间戳');

console.log('## 汇总');
const s = summarizeActionLog({ file });
ok(s.detail.turns === 1 && s.detail.sent === 1, '回合计数');
ok(s.detail.skips === 1, '限流跳过计数');
ok(s.detail.dives === 1 && s.detail.divesConsole === 1, '她设潜水 / 控制台各 1');
ok(s.detail.diaries === 1, '日记计数');
ok(/回合 1/.test(s.line), '一行账非空');

console.log('## 空文件');
const emptyFile = path.join(tmp, 'empty.jsonl');
const e = summarizeActionLog({ file: emptyFile });
ok(e.n === 0 && e.line === '' && e.detail && e.detail.turns === 0, '空文件返回零值结构（不抛）');

console.log('## 轮转');
const rotFile = path.join(tmp, 'rot.jsonl');
fs.writeFileSync(rotFile, 'x'.repeat(512 * 1024 + 10) + '\n', 'utf8'); // 超过 512KB 上限
logAction({ t: 'turn', key: 'g', trigger: 'timeout', outcome: 'closed' }, rotFile);
ok(fs.existsSync(`${rotFile}.old`), '超限后旧文件轮转为 .old');
const rotLines = fs.readFileSync(rotFile, 'utf8').split('\n').filter(Boolean);
ok(rotLines.length === 1 && JSON.parse(rotLines[0]).t === 'turn', '新文件只剩刚写的一条');

console.log('## 挂接纪律（纯观察锁）');
{
  // [DI-GETTER] console-server.mjs 里是注入调用（`__deps.logAction(...)`），
  // 以及 DI 用的 `get logAction() { return logAction; }`。前者归一成普通调用，
  // 后者是接线不是"使用返回值"，先剔掉——否则纯观察锁会误报。
  const bridge = readBridgeSource()
    .replace(/__deps\.logAction\(/g, 'logAction(')
    .replace(/^\s*get logAction\(\)[^\n]*$/gm, '');
  const lines = bridge.split('\n');
  const callLines = lines.filter((l) => l.includes('logAction(') && !l.includes('inori-actionlog.js'));
  ok(callLines.length >= 10, `bridge.js 有 ${callLines.length} 处挂接（≥10）`);
  // 每处 logAction( 的前一个 token 必须是语句边界（; 或 { 或行首）——
  // 出现在 if()/赋值/return/函数参数里，哪怕一处，都算变相约束她。
  const bad = callLines.filter((l) => {
    const i = l.indexOf('logAction(');
    const prev = l.slice(0, i).trimEnd().slice(-1);
    return !(prev === '' || prev === ';' || prev === '{');
  });
  ok(bad.length === 0, '没有把 logAction 塞进条件/赋值/返回值/参数', bad.length ? bad.slice(0, 3).join(' | ') : '');
  ok(!/=\s*logAction/.test(bridge) && !/return\s+logAction/.test(bridge), '结果不被使用（纯观察）');
  // 七类事件挂齐全（wake_config/turn 是多行对象字面量）
  for (const t of ['busy_stash', 'wake_skip', 'proactive_check', 'quiet_clamp', 'diary']) {
    ok(bridge.includes(`logAction({ t: '${t}'`), `挂接了 ${t}`);
  }
  ok(/logAction\(\{\s*\n\s*t: 'wake_config',/s.test(bridge), '挂接了 wake_config（她亲手设潜水）');
  ok(/logAction\(\{\s*\n\s*t: 'turn',/s.test(bridge), '挂接了 turn（回合收尾）');
}

console.log('## 行为账集成');
{
  const ledger = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'leaves', 'inori-behavior-ledger.js'), 'utf8');
  ok(/summarizeActionLog/.test(ledger), 'renderBehaviorLedger 会并入行动日志一行');
  ok(/catch\s*{/.test(ledger), '并入段有 try/catch（记不了不影响行为账）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
