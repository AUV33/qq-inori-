import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChecks,
  formatDuration,
  formatEventsLine,
  parseCrashLog,
  parseIncidents,
  runCheck,
  summarize,
  summarizeWindow,
} from '../scripts/health-check.mjs';

const liveStatus = {
  ok: true,
  mode: 'reserved2',
  role: '小满',
  dshReady: true,
  onebot: { connected: true, heartbeat: { seen: true, lastResult: { ok: true } }, queue: { pending: 0 } },
};

const okFetch = (routes) => async (url) => {
  const entry = routes[url];
  if (!entry) throw new Error(`unexpected url ${url}`);
  if (entry === 'timeout') {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  }
  const status = entry.status ?? 200;
  const body = entry.body ?? {};
  return {
    status,
    json: async () => body,
  };
};

test('buildChecks：必需项与可选项各就各位', () => {
  const checks = buildChecks({ consoleToken: 'tok', snowluma: { accessToken: 'abc' }, strict: false });
  const byId = new Map(checks.map((c) => [c.id, c]));
  for (const id of ['bridge', 'onebot', 'dsh', 'embed']) {
    assert.equal(byId.get(id)?.required, true, `${id} 应为必需`);
  }
  assert.equal(byId.get('dsh2')?.required, false);
  assert.equal(byId.get('rerank')?.required, false, '默认重排为可选');
  assert.equal(byId.get('bridge').headers['x-console-token'], 'tok');
  assert.equal(byId.get('onebot').headers.authorization, 'Bearer abc');
});

test('buildChecks：--strict 时重排变必需', () => {
  const byId = new Map(buildChecks({ strict: true }).map((c) => [c.id, c]));
  assert.equal(byId.get('rerank')?.required, true);
});

test('runCheck：桥接返回 ok:false 判为掉线', async () => {
  const check = buildChecks({}).find((c) => c.id === 'bridge');
  const result = await runCheck(check, {
    fetchImpl: okFetch({ 'http://127.0.0.1:3100/api/status': { body: { ok: false, error: '未授权' } } }),
  });
  assert.equal(result.status, 'down');
  assert.equal(result.detail, 'HTTP 200');
});

test('runCheck：在线时带出模式与角色', async () => {
  const check = buildChecks({}).find((c) => c.id === 'bridge');
  const result = await runCheck(check, {
    fetchImpl: okFetch({ 'http://127.0.0.1:3100/api/status': { body: liveStatus } }),
  });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /reserved2/);
  assert.match(result.detail, /小满/);
});

test('runCheck：OneBot 掉线不影响「桥接在线」的判定（网关另有单独检查）', async () => {
  const check = buildChecks({}).find((c) => c.id === 'bridge');
  const result = await runCheck(check, {
    fetchImpl: okFetch({
      'http://127.0.0.1:3100/api/status': {
        body: { ...liveStatus, onebot: { connected: false, heartbeat: { seen: false }, queue: { pending: 0 } } },
      },
    }),
  });
  assert.equal(result.status, 'ok', '桥接进程还在就该报 ok');
  assert.match(result.detail, /OneBot 离线/, '但要如实说网关离线');
});

test('runCheck：可选服务连不上记 skip，不算失败', async () => {
  const check = buildChecks({}).find((c) => c.id === 'rerank');
  const result = await runCheck(check, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(result.status, 'skip');
});

test('runCheck：必需服务连不上记 down', async () => {
  const check = buildChecks({}).find((c) => c.id === 'dsh');
  const result = await runCheck(check, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(result.status, 'down');
});

test('runCheck：超时被识别成超时文案', async () => {
  const check = buildChecks({}).find((c) => c.id === 'embed');
  const result = await runCheck(check, { fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.equal(result.status, 'down');
  assert.match(result.detail, /超时/);
});

test('summarize：任一必需项掉线即不健康', async () => {
  const checks = buildChecks({});
  const routes = {
    'http://127.0.0.1:3100/api/status': { body: liveStatus },
    'http://127.0.0.1:3000/get_login_info': { body: { status: 'ok', data: { user_id: 1, nickname: 'q' } } },
    'http://127.0.0.1:3080/': { status: 200, body: {} },
  };
  const results = [];
  for (const check of checks) {
    try {
      results.push(await runCheck(check, { fetchImpl: okFetch(routes) }));
    } catch (error) {
      // 未配置路由的项一律视为连不上
      results.push(await runCheck(check, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }));
    }
  }
  const summary = summarize(results);
  assert.equal(summary.ok, false);
  assert.ok(summary.failed.some((f) => f.id === 'embed'));
});

// ── P1-5：近 24h 事件统计 ────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-30T02:00:00.000Z');
const CRASH = [
  '2026-10-30T00:00:00.000Z [local 2026-10-30 08:00:00] [startup] pid=10 rss=40MB node=v24.21.0',
  '2026-10-30T00:05:00.000Z [local 2026-10-30 08:05:00] [heartbeat] pid=10 rss=40MB ',
  '2026-10-30T00:10:00.000Z [local 2026-10-30 08:10:00] [exit] pid=10 rss=40MB code=0',
  '2026-10-30T01:00:00.000Z [local 2026-10-30 09:00:00] [startup] pid=11 rss=40MB node=v24.21.0',
  '2026-10-30T01:30:00.000Z [local 2026-10-30 09:30:00] [heartbeat] pid=11 rss=40MB ',
  'this is not a log line',
].join('\n');
const INCIDENTS = [
  JSON.stringify({ ts: '2026-10-29T23:50:00.000Z', event: 'down', port: 3100, cause: 'killed', pid: 9 }),
  JSON.stringify({ ts: '2026-10-30T00:00:30.000Z', event: 'recovered', port: 3100, cause: 'killed', pid: 9, pidAfter: 10, by: 'vbs', recoveryMs: 30000 }),
  JSON.stringify({ ts: '2026-10-30T00:20:00.000Z', event: 'down', port: 3100, cause: 'hung', pid: 10 }),
  '{bad json',
].join('\n');

test('parseCrashLog：只认 startup/heartbeat/exit 行，坏行跳过', () => {
  const events = parseCrashLog(CRASH);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.kind), ['startup', 'heartbeat', 'exit', 'startup', 'heartbeat']);
  assert.equal(events[0].pid, 10);
  assert.equal(events[0].ts, Date.parse('2026-10-30T00:00:00.000Z'));
  assert.deepEqual(parseCrashLog(''), []);
});

test('parseIncidents：坏行跳过，能解析出 ts', () => {
  const incidents = parseIncidents(INCIDENTS);
  assert.equal(incidents.length, 3);
  assert.equal(incidents[0].event, 'down');
  assert.equal(incidents[1].recoveryMs, 30000);
});

test('summarizeWindow：24h 内启动/掉线/平均恢复/最长存活', () => {
  const stats = summarizeWindow({ crashLogText: CRASH, incidentsText: INCIDENTS, now: NOW });
  assert.equal(stats.startups, 2, '两次 [startup]');
  assert.equal(stats.drops, 2, '两条 down（23:50 与 00:20 都在窗口内）');
  assert.equal(stats.avgRecoveryMs, 30000);
  assert.equal(stats.longestAliveMs, 30 * 60 * 1000, 'pid=11 存活 30 分钟最长');
  assert.deepEqual(stats.causes, { killed: 1, hung: 1 });
  assert.equal(stats.windowHours, 24);
});

test('summarizeWindow：窗口外的旧记录被排除，缺文件得全 0', () => {
  const oldCrash = '2026-10-28T00:00:00.000Z [local 2026-10-28 08:00:00] [startup] pid=1 rss=1MB';
  const oldIncident = JSON.stringify({ ts: '2026-10-28T00:00:00.000Z', event: 'down', cause: 'killed' });
  const stats = summarizeWindow({ crashLogText: oldCrash, incidentsText: oldIncident, now: NOW });
  assert.equal(stats.startups, 0);
  assert.equal(stats.drops, 0);
  assert.equal(stats.avgRecoveryMs, null);
  assert.equal(stats.longestAliveMs, 0);

  const empty = summarizeWindow({ now: NOW });
  assert.equal(empty.startups, 0);
  assert.equal(empty.drops, 0);
});

test('summarizeWindow：跨窗口的进程只算窗口内那段', () => {
  const crash = [
    '2026-10-29T20:00:00.000Z [local 2026-10-30 04:00:00] [startup] pid=5 rss=1MB',
    '2026-10-30T00:00:00.000Z [local 2026-10-30 08:00:00] [heartbeat] pid=5 rss=1MB',
  ].join('\n');
  // 窗口起点 = 2026-10-29T02:00Z，进程从 20:00Z 开始，只算 20:00→00:00 = 4 小时（窗口内）
  const stats = summarizeWindow({ crashLogText: crash, incidentsText: '', now: NOW });
  assert.equal(stats.longestAliveMs, 4 * 60 * 60 * 1000);
});

test('formatDuration：分 / 时 的边界', () => {
  assert.equal(formatDuration(0), '0 分');
  assert.equal(formatDuration(5 * 60 * 1000), '5 分');
  assert.equal(formatDuration(65 * 60 * 1000), '1 时 5 分');
  assert.equal(formatDuration(120 * 60 * 1000), '2 时');
});

test('formatEventsLine：一行能读，平均恢复无记录时写「无记录」', () => {
  const line = formatEventsLine({ windowHours: 24, startups: 2, drops: 2, avgRecoveryMs: 30000, longestAliveMs: 30 * 60 * 1000 });
  assert.match(line, /近 24h：启动 2 次/);
  assert.match(line, /掉线 2 次/);
  assert.match(line, /平均恢复 30 秒/);
  assert.match(line, /最长存活 30 分/);
  assert.match(formatEventsLine({ windowHours: 24, startups: 0, drops: 0, avgRecoveryMs: null, longestAliveMs: 0 }), /无记录/);
});
