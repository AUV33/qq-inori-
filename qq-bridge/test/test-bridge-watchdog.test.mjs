import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {
  appendIncident,
  classifyDrop,
  createDepWatcher,
  missingDeps,
  dropContext,
  isPidAlive,
  killPid,
  probe,
  readBridgePid,
  recordIncident,
  recoverOnce,
  runLoop,
  waitAlive,
} from '../scripts/bridge-watchdog.mjs';

function listenTcp(port) {
  return new Promise((resolve, reject) => {
    // 只接连接、不回 HTTP：模拟「进程假死，内核仍在完成握手」。
    const server = net.createServer((sock) => { sock.on('data', () => {}); sock.on('error', () => {}); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function listenHttp(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { res.writeHead(401); res.end('unauthorized'); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// [PROBE-HTTP 2026-11-07] 探测必须看 HTTP 应答，不只看 TCP 握手：
// 桥接假死时内核仍完成握手（连接进 backlog），只看 connect 会把僵死进程判成健康。
test('probe：端口有 HTTP 应答（401 也算）→ true', async () => {
  const server = await listenHttp(0);
  const { port } = server.address();
  try {
    assert.equal(await probe(port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('probe：端口能连但 HTTP 无响应（假死）→ false', async () => {
  const server = await listenTcp(0);
  const { port } = server.address();
  try {
    const started = Date.now();
    assert.equal(await probe(port, 400), false);
    assert.ok(Date.now() - started < 2000, '假死探测应在超时附近返回，不能挂住');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('probe：端口没人监听 → false', async () => {
  assert.equal(await probe(1), false);
});

test('probe：超时不挂住（不可路由地址在超时内返回 false）', async () => {
  const started = Date.now();
  const ok = await probe(9, 300);
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 3000, '探测应在超时附近返回');
});

// [WATCHDOG-2026-10-29] 拉起流程：VBS 成功 → 直接起 node 兜底 → 都不行；失败要留痕，不能黑箱。
test('recoverOnce：VBS 拉起后等活成功就结束，不碰兜底', async () => {
  const calls = [];
  const r = await recoverOnce({
    startVbs: async () => { calls.push('vbs'); return { ok: true }; },
    startNode: () => { calls.push('node'); return { ok: true, pid: 1 }; },
    wait: async () => true,
    log: () => {},
  });
  assert.deepEqual(r, { by: 'vbs', ok: true });
  assert.deepEqual(calls, ['vbs'], 'VBS 成功就不该再起第二条');
});

test('recoverOnce：VBS 失败 → 直接起 node 兜底并等活', async () => {
  const calls = [];
  const r = await recoverOnce({
    startVbs: async () => { calls.push('vbs'); return { ok: false, error: 'powershell exit 1' }; },
    startNode: () => { calls.push('node'); return { ok: true, pid: 42 }; },
    wait: async () => true,
    log: () => {},
  });
  assert.deepEqual(r, { by: 'direct', ok: true });
  assert.deepEqual(calls, ['vbs', 'node']);
});

test('recoverOnce：VBS 冷启动慢（45s 没起来）→ 仍然兜底起 node', async () => {
  let waits = 0;
  const r = await recoverOnce({
    startVbs: async () => ({ ok: true }),
    startNode: () => ({ ok: true, pid: 7 }),
    wait: async () => { waits += 1; return waits >= 2; },
    log: () => {},
  });
  assert.deepEqual(r, { by: 'direct', ok: true });
});

test('recoverOnce：wait 收到的是毫秒数（不是 probe 函数）', async () => {
  // 2026-10-29 真机踩过：默认 wait 直接用了 waitAlive，结果 waitAlive(45000) 把数字当 probeFn，
  // watchdog 在第一次拉起后自己崩了（bridge 倒是被拉起来了）。这个断言锁住签名。
  const seen = [];
  const r = await recoverOnce({
    startVbs: async () => ({ ok: true }),
    wait: async (ms) => { seen.push(ms); return true; },
    log: () => {},
  });
  assert.deepEqual(r, { by: 'vbs', ok: true });
  assert.deepEqual(seen, [45_000], '传给 wait 的应是毫秒数');
});

test('recoverOnce：两条路都起不来 → ok=false，不假装成功', async () => {
  const r = await recoverOnce({
    startVbs: async () => ({ ok: false, error: 'spawn ENOENT' }),
    startNode: () => ({ ok: false, error: 'spawn EACCES' }),
    wait: async () => false,
    log: () => {},
  });
  assert.deepEqual(r, { by: 'none', ok: false });
});

test('waitAlive：探测真端口——有人应答立刻 true，没人监听超时 false', async () => {
  const server = await listenHttp(0);
  const { port } = server.address();
  try {
    const t0 = Date.now();
    assert.equal(await waitAlive(() => probe(port), 2000, 50), true);
    assert.ok(Date.now() - t0 < 1000, '已经在监听就不该干等');
    const t1 = Date.now();
    assert.equal(await waitAlive(() => probe(1), 300, 100), false);
    assert.ok(Date.now() - t1 >= 250, '要等满超时才判死');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// [P1-1 / P1-2] 掉线账本与归因三分：锁文件 PID / crash.log [exit] 是唯一证据。
test('readBridgePid：正常数字、空文件、坏值、读不到', () => {
  assert.equal(readBridgePid('lock', () => '18100\n'), 18100);
  assert.equal(readBridgePid('lock', () => ''), null);
  assert.equal(readBridgePid('lock', () => 'abc'), null);
  assert.equal(readBridgePid('lock', () => { throw new Error('ENOENT'); }), null);
});

test('isPidAlive：自己活着；ESRCH 死；EPERM 存在但没权限（算活）', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(42, () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }), false);
  assert.equal(isPidAlive(42, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }), true);
});

test('classifyDrop：进程在但端口不通 = hung', () => {
  assert.equal(classifyDrop({ pid: 7, pidAlive: true, crashLogText: '' }), 'hung');
});

test('classifyDrop：进程不在且有该 PID 的 [exit] = exited', () => {
  const text = '2026-10-30T01:00:00.000Z [local 2026-10-30 09:00:00] [startup] pid=7 rss=1MB\n2026-10-30T01:10:00.000Z [local 2026-10-30 09:10:00] [exit] pid=7 rss=1MB code=0';
  assert.equal(classifyDrop({ pid: 7, pidAlive: false, crashLogText: text }), 'exited');
});

test('classifyDrop：进程不在、没有 [exit] = killed（taskkill /F 走不到 handler）', () => {
  assert.equal(classifyDrop({ pid: 7, pidAlive: false, crashLogText: '[startup] pid=7 rss=1MB' }), 'killed');
});

test('classifyDrop：锁文件被正常退出删掉时，用 crash.log 最后一条 startup 的 PID 兜底', () => {
  const text = '[startup] pid=7 rss=1MB\n[exit] pid=7 rss=1MB code=0';
  assert.equal(classifyDrop({ pid: null, pidAlive: false, crashLogText: text }), 'exited');
  assert.equal(classifyDrop({ pid: null, pidAlive: false, crashLogText: '[startup] pid=8 rss=1MB' }), 'killed');
});

test('classifyDrop：没有任何证据 = unknown', () => {
  assert.equal(classifyDrop({ pid: null, pidAlive: false, crashLogText: '' }), 'unknown');
});

test('appendIncident：追加一行 JSON；写失败返回 false 不抛', () => {
  const lines = [];
  const appendFile = (file, line) => { lines.push({ file, line }); };
  assert.equal(appendIncident({ event: 'down', port: 3100 }, { file: 'inc.jsonl', appendFile }), true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].file, 'inc.jsonl');
  assert.deepEqual(JSON.parse(lines[0].line.trim()).event, 'down');
  assert.equal(appendIncident({}, { file: 'x', appendFile: () => { throw new Error('EACCES'); } }), false);
});

test('recordIncident：带时间戳与可选字段，pidAfter/recoveryMs 只在给出时出现', () => {
  const captured = [];
  const appendFile = (file, line) => captured.push(JSON.parse(line));
  recordIncident('down', { pid: 5, cause: 'killed', fails: 1, file: 'x', appendFile });
  recordIncident('recovered', { pid: 5, pidAfter: 6, cause: 'killed', by: 'vbs', recoveryMs: 23000, file: 'x', appendFile });
  assert.equal(captured[0].event, 'down');
  assert.equal(captured[0].pid, 5);
  assert.equal(captured[0].pidAfter, undefined);
  assert.equal(captured[1].pidAfter, 6);
  assert.equal(captured[1].by, 'vbs');
  assert.equal(captured[1].recoveryMs, 23000);
  assert.ok(Number.isFinite(Date.parse(captured[0].ts)), 'ts 必须是可解析的时间');
});

test('dropContext：活着的 PID 归因为 hung，没有 [exit] 的死 PID 归因为 killed', () => {
  assert.equal(dropContext({ pid: process.pid, crashLogText: '' }).cause, 'hung');
  assert.equal(dropContext({ pid: 999_999_999, crashLogText: '' }).cause, 'killed');
});

// [P1-1] 主循环状态迁移：不碰真端口，探测/拉起/记账全部注入。
function scriptedProbe(sequence) {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

function loopHarness(sequence, {
  threshold = 2,
  recover = async () => ({ by: 'vbs', ok: true }),
  context = () => ({ pid: 7, pidAlive: false, cause: 'killed' }),
  killFn = () => ({ ok: true, by: 'signal' }),
  pidNow = () => 7,
} = {}) {
  const records = [];
  const logs = [];
  const loop = runLoop({
    probeFn: scriptedProbe(sequence),
    recover,
    wait: async () => {},
    intervalMs: 1,
    failThreshold: threshold,
    logFn: (line) => logs.push(line),
    record: (event, payload) => records.push({ event, ...payload }),
    context,
    pidAfter: () => 8,
    pidNow,
    killFn,
    maxIterations: sequence.length,
  });
  return { loop, records, logs };
}

test('runLoop：一直活着 → 不写任何掉线账', async () => {
  const { loop, records } = loopHarness([true, true, true]);
  await loop;
  assert.deepEqual(records, []);
});

test('runLoop：掉线达到阈值 → down + probe_fail → 拉起成功 → recovered（vbs）', async () => {
  const { loop, records } = loopHarness([true, false, false, true]);
  await loop;
  assert.deepEqual(records.map((r) => r.event), ['down', 'probe_fail', 'recovered']);
  assert.equal(records[0].cause, 'killed');
  assert.equal(records[0].pid, 7);
  assert.equal(records[1].fails, 2);
  assert.equal(records[2].by, 'vbs');
  assert.equal(records[2].pidAfter, 8);
  assert.equal(records[2].fails, 2);
  assert.ok(records[2].recoveryMs >= 0);
});

test('runLoop：没到阈值就自己回来 → recovered 记 self', async () => {
  const { loop, records } = loopHarness([true, false, true], { threshold: 3 });
  await loop;
  assert.deepEqual(records.map((r) => r.event), ['down', 'recovered']);
  assert.equal(records[1].by, 'self');
  assert.equal(records[1].fails, 1);
});

test('runLoop：拉起失败 → recovery_failed；随后自己回来记 unknown（发起过但没成功）', async () => {
  const { loop, records } = loopHarness([true, false, false, true], {
    threshold: 2,
    recover: async () => ({ by: 'none', ok: false }),
  });
  await loop;
  assert.deepEqual(records.map((r) => r.event), ['down', 'probe_fail', 'recovery_failed', 'recovered']);
  assert.equal(records[3].by, 'unknown');
});

test('runLoop：hung → 先杀旧 pid 再拉起，不能只 re-spawn', async () => {
  const calls = [];
  const { loop, records } = loopHarness([true, false, false, true], {
    recover: async () => { calls.push('recover'); return { by: 'vbs', ok: true }; },
    context: () => ({ pid: 7, pidAlive: true, cause: 'hung' }),
    // [PID-REUSE] 强杀前会重读 bridge.lock：测试里显式给同一个 pid，才走 kill 分支。
    pidNow: () => 7,
    killFn: (pid) => { calls.push(`kill:${pid}`); return { ok: true, by: 'signal' }; },
  });
  await loop;
  assert.deepEqual(calls, ['kill:7', 'recover']);
  assert.deepEqual(records.map((r) => r.event), ['down', 'probe_fail', 'kill', 'recovered']);
  assert.equal(records.find((r) => r.event === 'kill')?.by, 'signal');
});

test('killPid：拒绝杀自己/坏 pid；正常 pid 走 signal', () => {
  assert.equal(killPid(0).ok, false);
  assert.equal(killPid(process.pid).ok, false);
  let seen = null;
  const r = killPid(123, { kill: (pid, sig) => { seen = { pid, sig }; } });
  assert.deepEqual(r, { ok: true, by: 'signal' });
  assert.deepEqual(seen, { pid: 123, sig: 'SIGKILL' });
});

test('runLoop：日志能读出归因与恢复耗时（人看得懂）', async () => {
  const { loop, logs } = loopHarness([true, false, true], { threshold: 3 });
  await loop;
  assert.ok(logs.some((line) => line.includes('归因：killed')), logs.join('\n'));
  assert.ok(logs.some((line) => line.includes('恢复')), logs.join('\n'));
});

test('missingDeps：只报 false 的依赖', () => {
  assert.deepEqual(missingDeps({ dsh: true, onebot: false, embed: true }), ['onebot']);
  assert.deepEqual(missingDeps({}), []);
});

test('dep watcher：连续两次缺失才启动；冷却内不重复；全在线不动作', async () => {
  let nowV = 0;
  const started = [];
  const status = { dsh: true, onebot: false, embed: true };
  const w = createDepWatcher({
    probeFn: async (port) => ({ 3080: status.dsh, 3000: status.onebot, 8790: status.embed })[port],
    startAll: () => { started.push(nowV); return { ok: true }; },
    autoStart: true,
    logFn: () => {},
    failThreshold: 2,
    cooldownMs: 10 * 60 * 1000,
    now: () => nowV,
  });
  let r = await w.tick();
  assert.equal(r.started, false, '第一次只记失败');
  r = await w.tick();
  assert.equal(r.started, true, '第二次触发 start-all');
  assert.equal(started.length, 1);
  // 冷却：再连续两次缺失也不重复启动
  nowV = 60_000;
  await w.tick();
  nowV = 61_000;
  r = await w.tick();
  assert.equal(r.started, false);
  assert.equal(started.length, 1, '冷却内不重复');
  // 恢复后不动作
  status.onebot = true;
  nowV = 20 * 60 * 1000;
  r = await w.tick();
  assert.equal(r.started, false);
});

test('dep watcher 默认只观察：缺失也不自动启动（内存有限）', async () => {
  let nowV = 0;
  const started = [];
  const w = createDepWatcher({
    probeFn: async () => false,
    startAll: () => { started.push(nowV); return { ok: true }; },
    logFn: () => {},
    failThreshold: 2,
    now: () => nowV,
  });
  await w.tick();
  const r = await w.tick();
  assert.equal(r.started, false);
  assert.equal(r.observed, true);
  assert.equal(started.length, 0, '默认不拉起全栈');
});
