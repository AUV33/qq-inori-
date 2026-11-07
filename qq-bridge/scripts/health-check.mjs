#!/usr/bin/env node
// health-check.mjs · 全栈只读健康检查（统一端口、期望状态码与超时）
//
// 为什么要有它：以前"她还在不在"靠人肉点端口/翻日志，每次判断口径都不一样。
// 这里把 3100 桥接、3000 OneBot、3080 DSH、8790 嵌入、3081 第二大脑和 8792 重排
// 收敛成一次只读探测：不重启、不写状态、不发 QQ，只回答「谁在线、谁不在线」。
// 3100 的检查包含 /api/status.onebot：connected + 心跳未超时 + 发送队列 pending。
//
// 用法：
//   node scripts/health-check.mjs            # 人看
//   node scripts/health-check.mjs --json     # 机器读
//   node scripts/health-check.mjs --verbose  # 带上失败原因
//
// 退出码：0 = 全部必需项在线；1 = 有必需项掉线；2 = 脚本自身出错。
// 8792 是「按需拉起」的，默认记为可选，掉线不影响退出码；--strict 时才算必需。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(HERE, '..');
const DEFAULT_TIMEOUT_MS = 2000;

function readConsoleToken() {
  try {
    return fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 构造检查清单。纯函数：不读文件、不发请求，方便单测。
 * @param {{consoleToken?: string, snowluma?: object, embedPort?: number, rerankPort?: number, strict?: boolean}} input
 */
export function buildChecks(input = {}) {
  const snowluma = input.snowluma ?? {};
  const httpUrl = String(snowluma.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(input.consoleToken ?? '');
  const embedPort = Number(input.embedPort ?? 8790);
  const rerankUrl = String(input.rerankUrl || `http://127.0.0.1:${Number(input.rerankPort ?? 8792)}`).replace(/\/+$/, '');
  let rerankPort = Number(input.rerankPort ?? 8792);
  try { rerankPort = Number(new URL(rerankUrl).port) || rerankPort; } catch { /* 配置不是 URL 时保留默认 */ }
  const auth = snowluma.accessToken ? { authorization: `Bearer ${snowluma.accessToken}` } : {};

  return [
    {
      id: 'bridge',
      label: '桥接 3100',
      required: true,
      url: 'http://127.0.0.1:3100/api/status',
      headers: token ? { 'x-console-token': token } : {},
      // [HEALTH-TRUTH] 这里只判"桥接本身还在不在"：以前要求 onebot.connected，导致 OneBot 一掉线
      // 就同时报「桥接 3100 掉线」，看起来像桥接挂了。网关另有专门的 onebot 检查负责。
      expect: (body) => body && body.ok !== false && typeof body.mode === 'string',
      detail: (body) => {
        const ob = body.onebot;
        const hb = ob?.heartbeat;
        const age = hb?.lastHeartbeatAt ? `${Math.max(0, Math.round((Date.now() - hb.lastHeartbeatAt) / 1000))}s 前` : '未见到';
        return `模式 ${body.mode}｜角色 ${body.role ?? '无'}｜DSH ${body.dshReady ? '就绪' : '未就绪'}｜OneBot ${ob?.connected ? '在线' : '离线'}｜心跳 ${age}｜发送队列 ${ob?.queue?.pending ?? '?'}`;
      },
    },
    {
      id: 'onebot',
      label: 'OneBot 3000',
      required: true,
      url: `${httpUrl}/get_login_info`,
      headers: auth,
      expect: (body) => body?.status === 'ok' || body?.retcode === 0,
      detail: (body) => `QQ ${body?.data?.user_id ?? '未知'}（${body?.data?.nickname ?? ''}）`,
    },
    {
      id: 'dsh',
      label: 'DSH 3080',
      required: true,
      url: 'http://127.0.0.1:3080/',
      headers: {},
      expect: (body, res) => res.status < 500,
      detail: () => '',
    },
    {
      id: 'embed',
      label: `嵌入 ${embedPort}`,
      required: true,
      url: `http://127.0.0.1:${embedPort}/health`,
      headers: {},
      expect: (body, res) => res.status < 500,
      detail: () => '',
    },
    {
      id: 'dsh2',
      label: '第二大脑 3081',
      required: false,
      url: 'http://127.0.0.1:3081/',
      headers: {},
      expect: (body, res) => res.status < 500,
      detail: () => '',
    },
    {
      id: 'rerank',
      label: `重排 ${rerankPort}`,
      required: Boolean(input.strict),
      url: `${rerankUrl}/`,
      headers: {},
      expect: () => true,
      detail: () => '按需拉起，未启动属正常',
    },
    // [WATCHDOG-CHECK] 自愈链的顶端必须可观测：旧六项检查全绿时，看护进程可能已经
    // 死了三天（现场即如此）。local:true 不探测 HTTP，直接读 pid + 日志新鲜度。
    {
      id: 'watchdog',
      label: '看护进程',
      required: Boolean(input.watchdog?.expected),
      local: true,
      run: () => {
        const wd = input.watchdog ?? {};
        if (!wd.expected) return { ok: true, detail: '未启用（没有 state/watchdog.pid）' };
        if (!wd.alive) return { ok: false, detail: `pid=${wd.pid} 不存活：掉线后没有人拉起桥接` };
        const ageMs = Number(wd.logAgeMs);
        if (!Number.isFinite(ageMs) || ageMs > 40 * 60 * 1000) {
          return { ok: false, detail: `pid=${wd.pid} 存活但日志 ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 60000)} 分钟` : '很久'}没更新（可能卡死）` };
        }
        return { ok: true, detail: `pid=${wd.pid}，日志 ${Math.round(ageMs / 60000)} 分钟前更新` };
      },
    },
  ];
}

/**
 * 跑一条检查。纯异步：fetch 可注入，便于单测。
 * @returns {Promise<{id: string, label: string, required: boolean, status: 'ok'|'down'|'skip', detail: string, ms: number}>}
 */
export async function runCheck(check, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const base = { id: check.id, label: check.label, required: check.required, detail: '' };
  // 本地检查（看护进程）不探测 HTTP，直接跑注入的 run()。
  if (typeof check.run === 'function') {
    try {
      const r = await check.run();
      return { ...base, status: r?.ok ? 'ok' : (check.required ? 'down' : 'skip'), detail: String(r?.detail ?? ''), ms: Date.now() - startedAt };
    } catch (error) {
      return { ...base, status: check.required ? 'down' : 'skip', detail: String(error?.message ?? error), ms: Date.now() - startedAt };
    }
  }
  try {
    const res = await fetchImpl(check.url, {
      headers: check.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    const ms = Date.now() - startedAt;
    if (!check.expect(body, res)) {
      return { ...base, status: 'down', detail: `HTTP ${res.status}`, ms };
    }
    return { ...base, status: 'ok', detail: safeDetail(check, body), ms };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const reason = error?.name === 'TimeoutError' ? `超时 >${timeoutMs}ms` : String(error?.message ?? error);
    // 可选服务连不上 = skip，不算失败
    return { ...base, status: check.required ? 'down' : 'skip', detail: reason, ms };
  }
}

function safeDetail(check, body) {
  try {
    return String(check.detail?.(body) ?? '');
  } catch {
    return '';
  }
}

/** 汇总退出码：必需项全 ok 才算健康。 */
export function summarize(results) {
  const failed = results.filter((r) => r.status === 'down');
  return { ok: failed.length === 0, failed, results };
}

// ── P1-5：近 24h 事件统计 ────────────────────────────────────────────────────
// 数据源只有两份、都是追加写的：state/crash.log（startup/heartbeat/exit）与
// state/incidents.jsonl（看门狗掉线账）。health-check 只读不写，坏行跳过。

/** 解析 crash.log 里可统计的事件行：[startup] / [heartbeat] / [exit]。 */
export function parseCrashLog(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[local [^\]]+\]\s+\[(startup|heartbeat|exit)\]\s+pid=(\d+)/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, kind: m[2], pid: Number(m[3]) });
  }
  return out;
}

/** 解析 incidents.jsonl（JSON Lines，坏行/无时间行跳过）。 */
export function parseIncidents(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      const ts = Date.parse(record.ts);
      if (Number.isFinite(ts)) out.push({ ...record, ts });
    } catch {
      // 坏行跳过：账本被截断也不该让 health-check 挂掉
    }
  }
  return out;
}

/** 每次进程生命周期内的存活时长，与统计窗口求交（跨窗口的进程只算窗口内那段）。 */
function aliveDurations(events, windowStart, windowEnd) {
  const perPid = new Map();
  for (const event of events) {
    const current = perPid.get(event.pid);
    if (event.kind === 'startup') {
      perPid.set(event.pid, { start: event.ts, last: event.ts });
    } else if (current) {
      current.last = Math.max(current.last, event.ts);
    }
  }
  return [...perPid.values()].map(({ start, last }) => {
    const from = Math.max(start, windowStart);
    const to = Math.min(last, windowEnd);
    return Math.max(0, to - from);
  });
}

/**
 * 近 24h 事件统计。纯函数，输入是两份文本，缺文件传空串即得全 0。
 * @returns {{windowHours:number, startups:number, drops:number, avgRecoveryMs:number|null, longestAliveMs:number, causes:object}}
 */
export function summarizeWindow({ crashLogText = '', incidentsText = '', now = Date.now(), windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const windowStart = now - windowMs;
  const events = parseCrashLog(crashLogText).filter((e) => e.ts >= windowStart && e.ts <= now);
  const incidents = parseIncidents(incidentsText).filter((e) => e.ts >= windowStart && e.ts <= now);

  const startups = events.filter((e) => e.kind === 'startup').length;
  const downEvents = incidents.filter((e) => e.event === 'down');
  const recovered = incidents.filter((e) => e.event === 'recovered' && Number.isFinite(e.recoveryMs));
  const avgRecoveryMs = recovered.length
    ? Math.round(recovered.reduce((sum, e) => sum + e.recoveryMs, 0) / recovered.length)
    : null;
  const durations = aliveDurations(events, windowStart, now);
  const longestAliveMs = durations.length ? Math.max(...durations) : 0;

  const causes = {};
  for (const event of downEvents) {
    const cause = String(event.cause ?? 'unknown');
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return {
    windowHours: Math.round(windowMs / (60 * 60 * 1000)),
    startups,
    drops: downEvents.length,
    avgRecoveryMs,
    longestAliveMs,
    causes,
  };
}

/** 毫秒 → 「X 时 Y 分 / X 分」。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 时 ${rest} 分` : `${hours} 时`;
}

/** 人看的一行统计。 */
export function formatEventsLine(stats) {
  const recovery = stats.avgRecoveryMs === null ? '无记录' : `${Math.round(stats.avgRecoveryMs / 1000)} 秒`;
  // [HONEST-METRIC] 掉线次数来自 incidents.jsonl（看护账本）。看护自己死掉/未启动的
  // 那段空窗不会记账，所以"0 次"只代表"看护看见的 0 次"，不能读成"没掉过线"。
  return `近 ${stats.windowHours}h：启动 ${stats.startups} 次 / 看护记账掉线 ${stats.drops} 次 / 平均恢复 ${recovery} / 最长存活 ${formatDuration(stats.longestAliveMs)}`;
}

/** 看护进程状态：pid 文件是否存在/进程是否存活/日志多久没更新。只读，不拉起。 */
function readWatchdogState() {
  const stateDir = path.join(BRIDGE_DIR, 'state');
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(stateDir, 'watchdog.pid'), 'utf8').trim()) || 0; } catch { pid = 0; }
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }
  let logAgeMs = null;
  try { logAgeMs = Date.now() - fs.statSync(path.join(stateDir, 'watchdog.log')).mtimeMs; } catch { logAgeMs = null; }
  return { expected: pid > 0, pid, alive, logAgeMs };
}

function readStateText(name) {
  try {
    return fs.readFileSync(path.join(BRIDGE_DIR, 'state', name), 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = readConfig();
  const checks = buildChecks({
    consoleToken: readConsoleToken(),
    snowluma: cfg.snowluma ?? {},
    embedPort: cfg.gate?.embedPort,
    rerankUrl: cfg.socialV2?.memoryRerank?.url,
    rerankPort: cfg.rerankPort,
    strict: args.has('--strict'),
    watchdog: readWatchdogState(),
  });
  const results = [];
  for (const check of checks) results.push(await runCheck(check));
  const { ok, failed } = summarize(results);
  const events24h = summarizeWindow({
    crashLogText: readStateText('crash.log'),
    incidentsText: readStateText('incidents.jsonl'),
  });

  if (args.has('--json')) {
    console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), events24h, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⚪' : '❌';
      const tail = r.detail ? `  ${r.detail}` : '';
      const opt = r.required ? '' : '（可选）';
      console.log(`${mark} ${r.label}${opt}  ${r.ms}ms${tail}`);
    }
    console.log(ok ? '\nHEALTH_OK：必需项全部在线' : `\nHEALTH_DOWN：${failed.map((f) => f.label).join('、')} 掉线`);
    console.log(`📈 ${formatEventsLine(events24h)}`);
  }

  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`health-check 自身出错: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
}
