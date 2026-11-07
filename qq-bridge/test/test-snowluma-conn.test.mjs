// 金标单测：src/adapters/snowluma-conn.js
//
// 只测纯函数 / 本地文件解析 / 候选排序 / 回退 / 持久化；不读用户真实 SnowLuma 配置：
// 一律 mkdtempSync(os.tmpdir()) 自造 fixture，探测网络用 globalThis.fetch 桩。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverSnowLumaConnection,
  persistSnowLumaEndpoint,
  persistToken,
  readOneBotHttpTokens,
  readOneBotTokens,
  snowLumaHomeCandidates,
} from '../src/adapters/snowluma-conn.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-conn-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let caseSeq = 0;
function caseDir() {
  caseSeq += 1;
  const dir = path.join(TMP, `case-${caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

/** 造一个 SnowLuma home：<home>/config/onebot_<uin>.json */
function makeHome(accounts) {
  const home = caseDir();
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  for (const acc of accounts) {
    const networks = {};
    if (acc.http) networks.httpServers = [acc.http];
    if (acc.ws) networks.wsServers = [acc.ws];
    writeJson(path.join(configDir, `onebot_${acc.uin}.json`), { networks });
  }
  return home;
}

async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const okLogin = (data = { user_id: 10001, nickname: 'neri' }) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok', retcode: 0, data }),
});
const unauthorized = { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) };

// ── snowLumaHomeCandidates ───────────────────────────────────────────────────

test('snowLumaHomeCandidates: 完整 cfg / 窄对象 / launcherPath 目录 / 环境变量 / 去重', async () => {
  await withEnv({ SNOWLUMA_HOME: undefined }, () => {
    assert.deepEqual(snowLumaHomeCandidates(), []);
    assert.deepEqual(snowLumaHomeCandidates({ cfg: {} }), []);

    const full = snowLumaHomeCandidates({
      cfg: { snowluma: { homeDir: 'C:/SnowLuma', launcherPath: 'C:/SnowLuma/bin/launcher.exe' } },
    });
    assert.deepEqual(full, ['C:/SnowLuma', 'C:/SnowLuma/bin']);

    // 窄对象：图形界面传的是没有 snowluma 这一层的 cfg（踩过的坑）
    const narrow = snowLumaHomeCandidates({
      cfg: { homeDir: 'D:/OneBot', launcherPath: 'D:/OneBot/tools/SnowLuma.exe' },
    });
    assert.deepEqual(narrow, ['D:/OneBot', 'D:/OneBot/tools']);

    // homeDir 与 launcherPath 目录相同 → 只留一条
    const dedup = snowLumaHomeCandidates({
      cfg: { snowluma: { homeDir: 'C:/SnowLuma', launcherPath: 'C:/SnowLuma/SnowLuma.exe' } },
    });
    assert.deepEqual(dedup, ['C:/SnowLuma']);
  });

  await withEnv({ SNOWLUMA_HOME: 'E:/env-snowluma' }, () => {
    const withEnvHome = snowLumaHomeCandidates({ cfg: { homeDir: 'C:/SnowLuma' } });
    assert.deepEqual(withEnvHome, ['C:/SnowLuma', 'E:/env-snowluma']);
    // 环境变量与 homeDir 相同也去重
    assert.deepEqual(
      snowLumaHomeCandidates({ cfg: { homeDir: 'E:/env-snowluma' } }),
      ['E:/env-snowluma']
    );
  });
});

// ── readOneBotTokens ────────────────────────────────────────────────────────

test('readOneBotTokens: 逐账号解析 HTTP/WS、缺省 host/port、坏文件与干扰项跳过、按 uin 排序', () => {
  const home = caseDir();
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  // 正常账号：HTTP 与 WS token 不同、端口不同
  writeJson(path.join(configDir, 'onebot_10002.json'), {
    networks: {
      httpServers: [{ accessToken: 'HTTP_TOKEN_B', host: '0.0.0.0', port: 4000 }],
      wsServers: [{ accessToken: 'WS_TOKEN_B', host: '0.0.0.0', port: 4001 }],
    },
  });
  // 只有 HTTP，字段缺省 + token 是数字（旧文件有这种）
  writeJson(path.join(configDir, 'onebot_10001.json'), {
    networks: { httpServers: [{ accessToken: 12345 }] },
  });
  // 只有 WS
  writeJson(path.join(configDir, 'onebot_10003.json'), {
    networks: { wsServers: [{ accessToken: 'ONLY_WS' }] },
  });
  // 坏 JSON：不能影响其它账号
  writeJson(path.join(configDir, 'onebot_99999.json'), '{ not json');
  // 名字不匹配 / 不是文件
  writeJson(path.join(configDir, 'onebot_abc.json'), { networks: {} });
  writeJson(path.join(configDir, 'notes.json'), { networks: {} });
  fs.mkdirSync(path.join(configDir, 'onebot_88888.json'));

  const rows = readOneBotTokens(home);
  assert.deepEqual(rows.map((r) => r.uin), ['10001', '10002', '10003']);

  const onlyHttp = rows[0];
  assert.equal(onlyHttp.file, path.join(configDir, 'onebot_10001.json'));
  assert.deepEqual(onlyHttp.http, { token: '12345', host: '127.0.0.1', port: 3000 });
  assert.equal(onlyHttp.ws, null);

  const both = rows[1];
  assert.deepEqual(both.http, { token: 'HTTP_TOKEN_B', host: '0.0.0.0', port: 4000 });
  assert.deepEqual(both.ws, { token: 'WS_TOKEN_B', host: '0.0.0.0', port: 4001 });

  const onlyWs = rows[2];
  assert.equal(onlyWs.http, null);
  assert.deepEqual(onlyWs.ws, { token: 'ONLY_WS', host: '127.0.0.1', port: 3001 });

  // 目录不存在 → 空数组，不抛
  assert.deepEqual(readOneBotTokens(path.join(home, 'no-such-dir')), []);
});

test('readOneBotTokens: 空 servers 数组按无该通道处理', () => {
  const home = caseDir();
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'onebot_10001.json'), {
    networks: { httpServers: [], wsServers: [] },
  });
  const rows = readOneBotTokens(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].http, null);
  assert.equal(rows[0].ws, null);
});

test('readOneBotHttpTokens: 只返回有 HTTP 通道的账号，字段扁平化', () => {
  const home = makeHome([
    { uin: '20002', http: { accessToken: 'H2', host: '10.0.0.2', port: 3000 }, ws: { accessToken: 'W2' } },
    { uin: '20001', http: { accessToken: 'H1' } },
    { uin: '20003', ws: { accessToken: 'W3' } },
  ]);
  const flat = readOneBotHttpTokens(home);
  assert.deepEqual(flat.map((r) => r.uin), ['20001', '20002']);
  assert.deepEqual(flat[1], {
    token: 'H2',
    uin: '20002',
    host: '10.0.0.2',
    port: 3000,
    file: path.join(home, 'config', 'onebot_20002.json'),
  });
});

// ── discoverSnowLumaConnection（fetch 桩） ──────────────────────────────────

test('discoverSnowLumaConnection: 显式 token 优先且成功即停，baseUrl 去尾斜杠', async () => {
  const home = makeHome([
    { uin: '10001', http: { accessToken: 'ACCOUNT_TOKEN' }, ws: { accessToken: 'WS_TOKEN' } },
  ]);
  const calls = [];
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return okLogin({ user_id: 42, nickname: 'explicit' });
  }, async () => {
    const result = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home, httpUrl: 'http://127.0.0.1:3999/' } },
      token: 'EXPLICIT_TOKEN',
    });
    assert.equal(result.ok, true);
    assert.equal(result.token, 'EXPLICIT_TOKEN');
    assert.equal(result.baseUrl, 'http://127.0.0.1:3999');
    assert.equal(result.source, 'config/env');
    assert.equal(result.self.nickname, 'explicit');
    assert.equal(result.wsToken, null);
    assert.equal(result.tried.length, 1);
    assert.equal(result.tried[0].ok, true);
    assert.equal(calls.length, 1, '显式 token 成功就不该再试账号 token');
    assert.equal(calls[0].url, 'http://127.0.0.1:3999/get_login_info');
  }));
});

test('discoverSnowLumaConnection: 候选顺序（显式→按 uin 排序的账号），403 前先试 HTTP token', async () => {
  const home = makeHome([
    { uin: '10002', http: { accessToken: 'HTTP_B', port: 3002 }, ws: { accessToken: 'WS_B', port: 3003 } },
    { uin: '10001', http: { accessToken: 'HTTP_A', port: 3001 }, ws: { accessToken: 'WS_A', port: 3011 } },
  ]);
  const seen = [];
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async (url, init) => {
    const auth = init.headers.authorization || '';
    seen.push(auth);
    if (auth === 'Bearer EXPIRED_TOKEN') return unauthorized;
    if (auth === 'Bearer HTTP_A') return okLogin({ user_id: 10001 });
    return unauthorized;
  }, async () => {
    const result = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home } },
      token: 'EXPIRED_TOKEN',
    });
    assert.equal(result.ok, true);
    assert.equal(result.token, 'HTTP_A');
    assert.equal(result.source, 'onebot_10001.json');
    assert.equal(result.baseUrl, 'http://127.0.0.1:3001');
    assert.equal(result.wsToken, 'WS_A');
    assert.equal(result.wsUrl, 'ws://127.0.0.1:3011');
    assert.deepEqual(result.tried.map((t) => t.source), ['config/env', 'onebot_10001.json']);
    assert.equal(result.tried[0].ok, false);
    assert.equal(result.tried[0].token, 'EXPI…', 'trace 里的 token 只留前 4 位');
    assert.equal(seen.length, 2);
  }));
});

test('discoverSnowLumaConnection: 显式 token 成功时按 user_id 找回同账号 WS 信息', async () => {
  const home = makeHome([
    { uin: '12345', http: { accessToken: 'HTTP_X' }, ws: { accessToken: 'WS_X', port: 3022 } },
  ]);
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async () => okLogin({ user_id: 12345 }), async () => {
    const result = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home } },
      token: 'EXPLICIT',
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'config/env');
    assert.equal(result.wsToken, 'WS_X');
    assert.equal(result.wsUrl, 'ws://127.0.0.1:3022');
  }));
});

test('discoverSnowLumaConnection: 同一 url|token 只试一次（去重）', async () => {
  const home = makeHome([
    { uin: '10001', http: { accessToken: 'SAME_TOKEN' } },
  ]);
  let calls = 0;
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async () => { calls += 1; return okLogin(); }, async () => {
    const result = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home, httpUrl: 'http://127.0.0.1:3000' } },
      token: 'SAME_TOKEN',
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal(result.tried.length, 1);
  }));
});

test('discoverSnowLumaConnection: 全部 401 给出可操作错误；只有 retcode 失败时回落到连接错误文案', async () => {
  const home = makeHome([
    { uin: '10001', http: { accessToken: 'HTTP_A' } },
  ]);
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async () => unauthorized, async () => {
    const result = await discoverSnowLumaConnection({
      cfg: { snowluma: { homeDir: home } },
      token: 'EXPLICIT',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /所有候选 token 都被拒绝（401）/);
    assert.equal(result.tried.length, 2);
  }));

  // OneBot 正常回 200 但 retcode != 0：不算 401，文案走「连不上」分支并带 wording
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'failed', retcode: 1401, wording: 'token 不对' }),
  }), async () => {
    const result = await discoverSnowLumaConnection({ homeDirs: [], token: 'TK' });
    assert.equal(result.ok, false);
    assert.match(result.error, /连不上 OneBot HTTP API（http:\/\/127\.0\.0\.1:3000）：token 不对/);
  }));
});

test('discoverSnowLumaConnection: fetch 抛错时连接原因必须回传（回归：曾退化成「未知错误」）', async () => {
  // 回归背景：probe() 把网络异常收进 { error }，但 discover 组装 tried 时曾只保留
  // wording/status、最终文案也只读 wording/status → ECONNREFUSED/超时全丢成「未知错误」。
  // 现在 tried 带 error、最终文案优先取 last.error（snowluma-conn.js:146、:170-173）。
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async () => {
    throw new Error('ECONNREFUSED');
  }, async () => {
    const result = await discoverSnowLumaConnection({ homeDirs: [], token: 'TK', baseUrl: 'http://127.0.0.1:3000' });
    assert.equal(result.ok, false);
    assert.equal(result.tried.length, 1);
    assert.equal(result.tried[0].ok, false);
    assert.equal(result.tried[0].error, 'ECONNREFUSED', 'tried 应保留探测异常原因');
    assert.match(result.error, /ECONNREFUSED/, '最终 error 不应退化成「未知错误」');
  }));
});

test('discoverSnowLumaConnection: 没有任何候选时用空 token 探测（不带 Authorization）', async () => {
  const seen = [];
  await withEnv({ SNOWLUMA_HTTP_URL: undefined, SNOWLUMA_TOKEN: undefined }, () => withFetch(async (_url, init) => {
    seen.push(init.headers);
    return okLogin({ user_id: 7 });
  }, async () => {
    const result = await discoverSnowLumaConnection({ homeDirs: [], cfg: null, baseUrl: 'http://127.0.0.1:3000' });
    assert.equal(result.ok, true);
    assert.equal(result.token, '');
    assert.equal(result.source, 'no-token');
    assert.equal(result.baseUrl, 'http://127.0.0.1:3000');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, undefined);
    assert.equal(result.tried[0].token, '(空)');
  }));
});

test('discoverSnowLumaConnection: 环境变量提供 baseUrl/token，显式参数优先', async () => {
  const urls = [];
  await withEnv(
    { SNOWLUMA_HTTP_URL: 'http://127.0.0.1:3555/', SNOWLUMA_TOKEN: 'ENV_TOKEN' },
    () => withFetch(async (url, init) => {
      urls.push({ url: String(url), auth: init.headers.authorization });
      return okLogin();
    }, async () => {
      const fromEnv = await discoverSnowLumaConnection({ homeDirs: [] });
      assert.equal(fromEnv.ok, true);
      assert.equal(fromEnv.token, 'ENV_TOKEN');
      assert.equal(fromEnv.baseUrl, 'http://127.0.0.1:3555');
      assert.equal(urls[0].url, 'http://127.0.0.1:3555/get_login_info');
      assert.equal(urls[0].auth, 'Bearer ENV_TOKEN');

      const explicit = await discoverSnowLumaConnection({
        homeDirs: [],
        baseUrl: 'http://127.0.0.1:3666',
        token: 'PARAM_TOKEN',
      });
      assert.equal(explicit.token, 'PARAM_TOKEN');
      assert.equal(explicit.baseUrl, 'http://127.0.0.1:3666');
      assert.equal(urls[1].auth, 'Bearer PARAM_TOKEN');
    })
  );
});

// ── persistToken / persistSnowLumaEndpoint ─────────────────────────────────

function cfgFile(value, { bom = false } = {}) {
  const dir = caseDir();
  const file = path.join(dir, 'config.json');
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text + '\n', 'utf8');
  return file;
}

test('persistToken: 只改 accessToken，返回 {updated, from, to}，其它字段不动', () => {
  const file = cfgFile({ snowluma: { accessToken: 'old-token', wsUrl: 'ws://127.0.0.1:3001' }, other: { keep: 1 } });
  const r1 = persistToken(file, 'new-token');
  assert.deepEqual(r1, { updated: true, from: 'old-token', to: 'new-token' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.snowluma.accessToken, 'new-token');
  assert.equal(saved.snowluma.wsUrl, 'ws://127.0.0.1:3001');
  assert.deepEqual(saved.other, { keep: 1 });

  // 幂等：同 token 不再写
  const r2 = persistToken(file, 'new-token');
  assert.deepEqual(r2, { updated: false, from: 'new-token', to: 'new-token' });

  // 没有 snowluma.accessToken 时 from 为空串
  const file2 = cfgFile({ other: true });
  const r3 = persistToken(file2, 'first-token');
  assert.deepEqual(r3, { updated: true, from: '', to: 'first-token' });
  assert.equal(JSON.parse(fs.readFileSync(file2, 'utf8')).snowluma.accessToken, 'first-token');
});

test('persistToken: 保留用户文件的 UTF-8 BOM（字节级不静默改写）', () => {
  const file = cfgFile({ snowluma: { accessToken: 'old' } }, { bom: true });
  assert.equal(fs.readFileSync(file)[0], 0xEF);
  persistToken(file, 'new');
  const raw = fs.readFileSync(file);
  assert.equal(raw[0], 0xEF);
  assert.equal(raw[1], 0xBB);
  assert.equal(raw[2], 0xBF);
  assert.equal(JSON.parse(raw.toString('utf8').slice(1)).snowluma.accessToken, 'new');
});

test('persistToken: 文件缺失 / JSON 坏 → 抛错（不静默造配置）', () => {
  const dir = caseDir();
  assert.throws(() => persistToken(path.join(dir, 'nope.json'), 't'), /ENOENT/);
  const bad = cfgFile('{ broken json');
  assert.throws(() => persistToken(bad, 't'));
});

test('persistSnowLumaEndpoint: 一次写 accessToken/wsUrl/httpUrl，changed 记录 from/to', () => {
  const file = cfgFile({ snowluma: { accessToken: 'old-http' }, unrelated: [1, 2] });
  const r = persistSnowLumaEndpoint(file, {
    accessToken: 'new-http',
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
  });
  assert.equal(r.updated, true);
  assert.deepEqual(r.changed, {
    accessToken: { from: 'old-http', to: 'new-http' },
    wsUrl: { from: null, to: 'ws://127.0.0.1:3001' },
    httpUrl: { from: null, to: 'http://127.0.0.1:3000' },
  });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.snowluma.accessToken, 'new-http');
  assert.equal(saved.snowluma.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(saved.snowluma.httpUrl, 'http://127.0.0.1:3000');
  assert.deepEqual(saved.unrelated, [1, 2]);
});

test('persistSnowLumaEndpoint: 全一致时不写文件（幂等）；空/undefined/null 不覆盖', () => {
  const file = cfgFile({ snowluma: { accessToken: 'same' } });
  const before = fs.readFileSync(file, 'utf8');
  const r1 = persistSnowLumaEndpoint(file, { accessToken: 'same' });
  assert.deepEqual(r1, { updated: false, changed: {} });
  assert.equal(fs.readFileSync(file, 'utf8'), before, '幂等时文件字节不变');

  const r2 = persistSnowLumaEndpoint(file, { accessToken: '', wsUrl: null, httpUrl: undefined });
  assert.deepEqual(r2, { updated: false, changed: {} });
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // 只写 wsUrl 时其它字段保持
  const r3 = persistSnowLumaEndpoint(file, { wsUrl: 'ws://127.0.0.1:3999' });
  assert.equal(r3.updated, true);
  assert.deepEqual(r3.changed, { wsUrl: { from: null, to: 'ws://127.0.0.1:3999' } });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.snowluma.accessToken, 'same');
  assert.equal(saved.snowluma.wsUrl, 'ws://127.0.0.1:3999');
});

test('persistSnowLumaEndpoint: 没有 snowluma 段时新建；BOM 原样保留', () => {
  const plain = cfgFile({ other: 1 });
  const r = persistSnowLumaEndpoint(plain, { accessToken: 'tk' });
  assert.equal(r.updated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(plain, 'utf8')), {
    other: 1,
    snowluma: { accessToken: 'tk' },
  });

  const bomFile = cfgFile({ snowluma: { wsUrl: 'ws://old' } }, { bom: true });
  persistSnowLumaEndpoint(bomFile, { wsUrl: 'ws://new' });
  const raw = fs.readFileSync(bomFile);
  assert.equal(raw[0], 0xEF);
  assert.equal(JSON.parse(raw.toString('utf8').slice(1)).snowluma.wsUrl, 'ws://new');
});
