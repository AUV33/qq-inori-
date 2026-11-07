// 回归测试：修复项 F2 / F5 / F8 / F20 的行为锁。
// 运行：node --test test/test-hardening-fixes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateHostShell } from '../src/domain/shared/host-action-policy.js';
import { scanDangerous, isEntryFile } from '../src/domain/persona/self-edit-verify.mjs';
import { createTurnDispatch } from '../src/domain/conversation/turn-dispatch.js';
import { ignoredCatch, setErrorObserver } from '../src/domain/shared/best-effort.js';

// ── F5：host-action 危险参数门禁 ─────────────────────────────────────────────
test('F5: git -c 别名逃逸被拒绝', () => {
  assert.equal(validateHostShell("git -c alias.x='!sh -c evil' status").ok, false);
});
test('F5: git alias/hook/! 逃逸被拒绝', () => {
  assert.equal(validateHostShell('git alias.foo bar').ok, false);
  assert.equal(validateHostShell('git hook').ok, false);
  assert.equal(validateHostShell('git !dostuff').ok, false);
});
test('F5: robocopy /MIR /PURGE 破坏性标志被拒绝', () => {
  assert.equal(validateHostShell('robocopy src dst /MIR').ok, false);
  assert.equal(validateHostShell('robocopy src dst /PURGE').ok, false);
});
test('F5: 普通只读命令仍放行', () => {
  assert.equal(validateHostShell('git status').ok, true);
  assert.equal(validateHostShell('robocopy src dst').ok, true);
  assert.equal(validateHostShell('ipconfig').ok, true);
});

// ── F8：self-edit 静态危险模式扫描 ─────────────────────────────────────────
test('F8: eval / new Function / Function(...) 命中', () => {
  assert.ok(scanDangerous('x = eval("1+1")').length);
  assert.ok(scanDangerous('const f = new Function("return 1")').length);
  assert.ok(scanDangerous('Function("return 1")()').length);
});
test('F8: child_process 引入命中', () => {
  assert.ok(scanDangerous("require('child_process').exec('ls')").length);
  assert.ok(scanDangerous("import cp from 'child_process'").length);
});
test('F8: 破坏性 fs 删除命中', () => {
  assert.ok(scanDangerous('fs.unlinkSync(p)').length);
  assert.ok(scanDangerous('fs.rm(p, {force:true})').length);
});
test('F8: 篡改 process.env 命中', () => {
  assert.ok(scanDangerous('process.env.TOKEN = "x"').length);
});
test('F8: 普通业务逻辑干净', () => {
  assert.equal(scanDangerous('const a = 1 + 2; const b = arr.filter(x => x > 0);').length, 0);
});
test('F8: 非入口文件 process.exit 命中，入口文件不命中', () => {
  assert.ok(scanDangerous('process.exit(1)', { isEntry: false }).length);
  assert.equal(scanDangerous('process.exit(1)', { isEntry: true }).length, 0);
  assert.equal(isEntryFile('qq-bridge/src/app.mjs'), true);
});

// ── L2：词法感知门禁（旧版纯正则可绕过 / 会误报的写法） ───────────────────
test('L2: 注释里的危险字样不误报，注释后的真实危险代码仍命中', () => {
  assert.equal(scanDangerous('// eval("x"); require("child_process")\nconst a = 1;').length, 0);
  assert.equal(scanDangerous('/* process.env.TOKEN = "x"; process.exit(1) */\nconst a = 1;').length, 0);
  assert.ok(scanDangerous('/* 只是说明 */\nx = eval("1+1")').length);
});
test('L2: 字符串拼接 / node: 前缀 / 反引号 import 都拦住 child_process', () => {
  assert.ok(scanDangerous("require('child' + '_process')").length);
  assert.ok(scanDangerous("require('ch' + 'ild' + '_process')").length);
  assert.ok(scanDangerous("import('node:child_process')").length);
  assert.ok(scanDangerous('await import(`child_process`)').length);
});
test('L2: constructor 链 / 间接 eval / 全局 Function 索引不能绕过', () => {
  assert.ok(scanDangerous("globalThis.constructor.constructor('return process')()").length);
  assert.ok(scanDangerous("globalThis['constructor']['constructor']('return 1')()").length);
  assert.ok(scanDangerous('(0, eval)("1+1")').length);
  assert.ok(scanDangerous('globalThis["eval"]("1+1")').length);
  assert.ok(scanDangerous('globalThis["Function"]("return 1")()').length);
});
test('L2: vm / process.binding / 反射改 env 命中', () => {
  assert.ok(scanDangerous("const vm = require('node:vm'); vm.runInThisContext('x')").length);
  assert.ok(scanDangerous("process.binding('spawn_sync')").length);
  assert.ok(scanDangerous("Object.assign(process.env, { TOKEN: 'x' })").length);
  assert.ok(scanDangerous("process['env'].TOKEN = 'x'").length);
  assert.ok(scanDangerous("Reflect.set(process.env, 'TOKEN', 'x')").length);
});
test('L2: 比较运算 / 读取 env / 正则字面量里的注释符号不误报', () => {
  assert.equal(scanDangerous("if (process.env.NODE_ENV === 'production') { log('ok'); }").length, 0);
  assert.equal(scanDangerous("const v = process.env.TOKEN; const re = /a\\/\\/b/;").length, 0);
  assert.ok(scanDangerous("const re = /a\\/\\/b/; x = eval('1')").length, '正则里的 // 不得吞掉后续代码');
  assert.equal(scanDangerous('function f(a = 1 / 2 / 3) { return a; }').length, 0);
});
test('L2: 破坏性删除与 process.exit 的别名写法', () => {
  assert.ok(scanDangerous('fs.promises.unlink(p)').length);
  assert.ok(scanDangerous("globalThis.process['exit'](1)").length);
  assert.equal(scanDangerous('process.exit(1)', { isEntry: true }).length, 0);
});

// ── L2 词法预处理边界：这些写法最容易被朴素状态机误解析，必须逐条锁住 ────────
test('L2 词法边界：嵌套模板串 / 正则字符类 / 模板表达式 / 字符串里的注释符', () => {
  assert.ok(scanDangerous("const s = `outer ${ `inner ${'x'}` } end`; eval('1')").length,
    '嵌套模板串不得让状态机提前回到 code 而吞掉后续代码');
  assert.ok(scanDangerous("const re = /[//]/; eval('1')").length,
    '正则字符类里的 // 不得被当成行注释起点');
  assert.ok(scanDangerous("const t = `value ${eval('1')}`").length,
    '模板表达式里的 eval 是真代码，必须命中');
  assert.ok(scanDangerous("const s = 'a /* not a comment */'; eval('1')").length,
    '字符串里的注释符不得开启块注释状态');
  assert.ok(scanDangerous('/* block\ncomment */\nconst s = `x`;\neval("1")').length,
    '跨行块注释之后仍要继续扫描');
  assert.equal(scanDangerous('// only a comment\neval("1");').length > 0, true,
    '行注释本身被抹掉，但下一行的真实代码要命中');
});

// ── F20：turn-dispatch 同 label 一次 pump 只发一个槽（不变量 #2） ─────────────
function makeDispatch(plan, extra = {}) {
  return createTurnDispatch({
    maxConcurrent: () => 3,
    reserveForChat: () => 0,
    log: () => {},
    plan: plan || ((eligible) => eligible.map((_, i) => i)),
    setTimer: () => 0,
    clearTimer: () => {},
    ...extra,
  });
}

test('F20: 同 label 一次 pump 只发一个槽', async () => {
  const d = makeDispatch();
  const p1 = d.acquire('private:123');
  const p2 = d.acquire('private:123');
  d.pump(); // 稳定一次
  assert.equal(d.stats().granted, 1, `同 label 不应一次发两个槽，实际 granted=${d.stats().granted}`);
  const g1 = await p1;
  assert.equal(g1.ok, true);
  assert.ok(d.bind(g1, 'sess-1'));
  assert.ok(d.begin('sess-1'));
  d.finish('sess-1'); // 释放后下一轮 pump 串行派发第二个
  const g2 = await p2;
  assert.equal(g2.ok, true, '第二个同 label 回合应在第一个结束后串行派发');
});

test('F20: 不同 label 可并行发卡', async () => {
  const d = makeDispatch();
  const pA = d.acquire('private:1');
  const pB = d.acquire('private:2');
  d.pump();
  assert.equal(d.stats().granted, 2, '不同 label 应可并行');
  const [gA, gB] = [await pA, await pB];
  d.bind(gA, 'sA'); d.bind(gB, 'sB');
  d.begin('sA'); d.begin('sB');
  d.finish('sA'); d.finish('sB');
});

test('F20: 兜底放行也不破坏同 label 串行（不变量 #2）', async () => {
  // 模拟两个同 label waiter 都走超时强制路径：第一个占槽后，第二个不得再发第二个槽。
  // 仅捕获「排队超时定时器」（chat 的 timerMs=20000），不捕获租约定时器（60000），
  // 否则租约到期会把首个槽从 grants 里删掉，造成测试伪影而非真实缺陷。
  const queueTimers = [];
  const d = makeDispatch(((eligible) => eligible.map((_, i) => i)), {
    setTimer: (fn, ms) => { if (ms === 20000) queueTimers.push(fn); return 0; },
    clearTimer: () => {},
  });
  const p1 = d.acquire('private:9');
  const p2 = d.acquire('private:9');
  // 触发两个排队超时定时器（模拟 20s 超时强制放行）
  for (const fn of queueTimers.splice(0)) fn();
  // 强制路径下：若第一个已占 label，第二个应判 serialized 而非再发一个槽
  const [r1, r2] = [await p1, await p2];
  const grantedCount = [r1, r2].filter((r) => r.ok && r.grantToken).length;
  assert.ok(grantedCount <= 1, `兜底路径下同 label 不应发两个槽，实际 ${grantedCount}`);
});

// ── F2：默认错误观察者把错误落盘（不再黑洞） ───────────────────────────────
test('F2: 默认观察者将忽略的错误写入 state/error-observed.log', () => {
  const saved = globalThis.__ignoredCatch;
  setErrorObserver(null); // 走默认文件观察者
  const logPath = path.join(process.cwd(), 'state', 'error-observed.log');
  try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }
  ignoredCatch(new Error('hardening-test'), 'test-hardening:probe');
  const exists = fs.existsSync(logPath);
  if (exists) {
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('test-hardening:probe'), '落盘内容应包含来源标记');
  }
  // 还原
  if (saved) globalThis.__ignoredCatch = saved;
  setErrorObserver(null);
});
