// 金标单测：src/adapters/dsh-client.js
//
// 只测纯函数 / 本地解析 / Cookie 铸造 / 协议封装；不联网、不读用户真实 ~/.dsh：
// 一律用 fs.mkdtempSync(os.tmpdir()) 造 DSH_HOME fixture + 测试后清理。
// callUnary 的传输层用注入的 globalThis.fetch 桩（被测代码自己不发起网络）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import {
  FOLLOW_SNAPSHOT_MESSAGES,
  MINTED_COOKIE_LIFETIME_MS,
  NodeApiClient,
  createTurnCollector,
  discoverDshLaunchToken,
  discoverDshSessionCookie,
  isLoopbackBase,
  mintBrowserSessionCookie,
  readBrowserSessionSecret,
  resolveDshHome,
  unwrap,
} from '../src/adapters/dsh-client.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-client-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let caseSeq = 0;
function caseDir() {
  caseSeq += 1;
  const dir = path.join(TMP, `case-${caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const B64URL = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

async function withEnv(name, value, fn) {
  const had = Object.hasOwn(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

function writeCreds(home, secretBytes) {
  fs.mkdirSync(home, { recursive: true });
  const secret = B64URL(secretBytes);
  const yaml = [
    'version: 1',
    'records:',
    '  "client-connection/browser-session":',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secret}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), yaml, 'utf8');
  return secret;
}

function writeLog(dir, name, text, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function decodeCookie(cookie) {
  const eq = cookie.indexOf('=');
  assert.ok(eq > 0, 'cookie 必须形如 name=value');
  const name = cookie.slice(0, eq);
  const value = cookie.slice(eq + 1);
  const parts = value.split('.');
  assert.equal(parts.length, 3, 'value 必须是 v1.<body>.<sig>');
  assert.equal(parts[0], 'v1');
  const rawBody = parts[1];
  const bodyText = Buffer.from(rawBody.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
  return { name, version: parts[0], rawBody, bodyText, body: JSON.parse(bodyText), sig: parts[2] };
}

// ── resolveDshHome ────────────────────────────────────────────────────────────

test('resolveDshHome: DSH_HOME 优先，未设置时回落到 ~/.dsh', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, () => {
    assert.equal(resolveDshHome(), home);
  });
  await withEnv('DSH_HOME', undefined, () => {
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'));
  });
});

// ── discoverDshLaunchToken ────────────────────────────────────────────────────

test('discoverDshLaunchToken: 合法环境变量直接采用', async () => {
  const home = caseDir();
  const token = 'AbCdEf0123456789_-xyz';
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', token, () => {
      assert.equal(discoverDshLaunchToken(), token);
    });
  });
});

test('discoverDshLaunchToken: 环境变量不合法时忽略并继续找日志', async () => {
  const home = caseDir();
  writeLog(path.join(home, 'logs'), 'server-1.log', 'http://127.0.0.1:3080/?token=LOG_TOKEN_123');
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', 'short', () => {
      assert.equal(discoverDshLaunchToken(), 'LOG_TOKEN_123');
    });
    await withEnv('DSH_LAUNCH_TOKEN', 'bad token with spaces!', () => {
      assert.equal(discoverDshLaunchToken(), 'LOG_TOKEN_123');
    });
  });
});

test('discoverDshLaunchToken: 日志按 mtime 从新到旧，跳过没 token 的新日志', async () => {
  const home = caseDir();
  const dir = path.join(home, 'logs');
  writeLog(dir, 'server-new.out.log', 'started without a token', 3_000_000);
  writeLog(dir, 'server-mid.log', 'http://127.0.0.1:3080/?token=MID_TOKEN', 2_000_000);
  writeLog(dir, 'server-old.out.log', 'http://127.0.0.1:3080/?token=OLD_TOKEN', 1_000_000);
  writeLog(dir, 'unrelated.txt', 'http://127.0.0.1:3080/?token=NOPE', 9_000_000);
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', undefined, () => {
      assert.equal(discoverDshLaunchToken(), 'MID_TOKEN');
    });
  });
});

test('discoverDshLaunchToken: 只认 ?token= / &token=，裸 token= 不算；缺目录返回空串', async () => {
  const home = caseDir();
  writeLog(path.join(home, 'logs'), 'server-bare.log', 'token=BARE_TOKEN');
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', undefined, () => {
      assert.equal(discoverDshLaunchToken(), '');
    });
  });
  const emptyHome = caseDir();
  await withEnv('DSH_HOME', emptyHome, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', undefined, () => {
      assert.equal(discoverDshLaunchToken(), '');
    });
  });
});

test('discoverDshLaunchToken: DSH_HOME/logs 没有 token 时回落到 guard/logs', async () => {
  const home = caseDir();
  writeLog(path.join(home, 'logs'), 'server-a.log', 'no token here');
  writeLog(path.join(home, 'guard', 'logs'), 'server-guard.out.log', 'http://x/?token=GUARD_TOKEN');
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', undefined, () => {
      assert.equal(discoverDshLaunchToken(), 'GUARD_TOKEN');
    });
  });
});

// ── 浏览器会话签名密钥 ────────────────────────────────────────────────────────

test('readBrowserSessionSecret: 合法 32 字节 secret 解出 Buffer', async () => {
  const home = caseDir();
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  writeCreds(home, bytes);
  await withEnv('DSH_HOME', home, () => {
    const secret = readBrowserSessionSecret();
    assert.ok(Buffer.isBuffer(secret));
    assert.equal(secret.byteLength, 32);
    assert.deepEqual(secret, bytes);
  });
});

test('readBrowserSessionSecret: 文件缺失 / 结构不符 / 密钥长度不对都返回 null', async () => {
  // 文件缺失
  const missing = caseDir();
  await withEnv('DSH_HOME', missing, () => assert.equal(readBrowserSessionSecret(), null));

  // kind 不是 grant
  const wrongKind = caseDir();
  fs.writeFileSync(path.join(wrongKind, '.credentials.yaml'), [
    'records:',
    '  "client-connection/browser-session":',
    '    kind: token',
    '    payload:',
    '      version: 1',
    `      secret: ${B64URL(Buffer.alloc(32, 7))}`,
  ].join('\n'), 'utf8');
  await withEnv('DSH_HOME', wrongKind, () => assert.equal(readBrowserSessionSecret(), null));

  // payload.version 不是 1
  const wrongVersion = caseDir();
  fs.writeFileSync(path.join(wrongVersion, '.credentials.yaml'), [
    'records:',
    '  "client-connection/browser-session":',
    '    kind: grant',
    '    payload:',
    '      version: 2',
    `      secret: ${B64URL(Buffer.alloc(32, 7))}`,
  ].join('\n'), 'utf8');
  await withEnv('DSH_HOME', wrongVersion, () => assert.equal(readBrowserSessionSecret(), null));

  // secret 含非 base64url 字符
  const badSecret = caseDir();
  fs.writeFileSync(path.join(badSecret, '.credentials.yaml'), [
    'records:',
    '  "client-connection/browser-session":',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: "not a secret!!"',
  ].join('\n'), 'utf8');
  await withEnv('DSH_HOME', badSecret, () => assert.equal(readBrowserSessionSecret(), null));

  // 解出来只有 16 字节
  const shortSecret = caseDir();
  fs.writeFileSync(path.join(shortSecret, '.credentials.yaml'), [
    'records:',
    '  "client-connection/browser-session":',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${B64URL(Buffer.alloc(16, 3))}`,
  ].join('\n'), 'utf8');
  await withEnv('DSH_HOME', shortSecret, () => assert.equal(readBrowserSessionSecret(), null));

  // 坏 YAML 不抛
  const broken = caseDir();
  fs.writeFileSync(path.join(broken, '.credentials.yaml'), 'records: [unclosed', 'utf8');
  await withEnv('DSH_HOME', broken, () => assert.equal(readBrowserSessionSecret(), null));
});

// ── Cookie 铸造 ───────────────────────────────────────────────────────────────

test('mintBrowserSessionCookie: 名称绑定 authority，载荷绑定时间窗，签名可复算', () => {
  const authority = '127.0.0.1:3080';
  const secret = Buffer.alloc(32, 0xab);
  const before = Date.now();
  const cookie = mintBrowserSessionCookie(`http://${authority}/some/path?q=1`, secret);
  const parsed = decodeCookie(cookie);

  const expectedName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  assert.equal(parsed.name, expectedName);
  assert.equal(parsed.body.version, 1);
  assert.equal(parsed.body.authority, authority);
  assert.ok(parsed.body.issuedAt >= before - 5 && parsed.body.issuedAt <= Date.now() + 5);
  assert.equal(parsed.body.expiresAt - parsed.body.issuedAt, MINTED_COOKIE_LIFETIME_MS);

  const expectedSig = createHmac('sha256', secret).update(parsed.rawBody).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  assert.equal(parsed.sig, expectedSig);
});

test('mintBrowserSessionCookie: 自定义 lifetimeMs 与 https 地址', () => {
  const secret = Buffer.alloc(32, 1);
  const cookie = mintBrowserSessionCookie('https://localhost:8443/', secret, { lifetimeMs: 1234 });
  const { body } = decodeCookie(cookie);
  assert.equal(body.authority, 'localhost:8443');
  assert.equal(body.expiresAt - body.issuedAt, 1234);
});

test('mintBrowserSessionCookie: 非法 baseUrl 抛错', () => {
  const secret = Buffer.alloc(32, 2);
  assert.throws(() => mintBrowserSessionCookie('not a url', secret), /Invalid URL|URL/);
  assert.throws(() => mintBrowserSessionCookie('', secret), /Invalid URL|URL/);
});

test('discoverDshSessionCookie: 有密钥铸造、密钥缺失或地址非法返回空串', async () => {
  const home = caseDir();
  writeCreds(home, Buffer.alloc(32, 9));
  await withEnv('DSH_HOME', home, () => {
    const cookie = discoverDshSessionCookie('http://127.0.0.1:3080');
    assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(discoverDshSessionCookie('not a url'), '');

    const emptyHome = caseDir();
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = emptyHome;
    try {
      assert.equal(discoverDshSessionCookie('http://127.0.0.1:3080'), '');
    } finally {
      process.env.DSH_HOME = prev;
    }
  });
});

// ── 回环判断 ──────────────────────────────────────────────────────────────────

test('isLoopbackBase: 只认回环网段 / localhost / ::1', () => {
  const loopbacks = [
    'http://127.0.0.1:3080',
    'https://127.0.0.1',
    'http://127.9.9.9:3000',
    'http://localhost:3080',
    'http://LOCALHOST:3080',
    'http://foo.localhost:3080',
    'http://[::1]:3080',
  ];
  for (const url of loopbacks) assert.equal(isLoopbackBase(url), true, url);
  const remotes = [
    'http://192.168.1.10:3080',
    'http://10.0.0.1:3080',
    'http://example.com',
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'not a url',
    '',
    undefined,
  ];
  for (const url of remotes) assert.equal(isLoopbackBase(url), false, String(url));
});

// ── unwrap ───────────────────────────────────────────────────────────────────

test('unwrap: 成功取 value，错误抛 label: code: message', () => {
  assert.deepEqual(unwrap({ result: { ok: true, value: { a: 1 } } }, 'session/list'), { a: 1 });
  assert.throws(
    () => unwrap({ result: { ok: false, error: { code: 'bad', message: 'nope' } } }, 'session/create'),
    /session\/create failed: bad: nope/
  );
});

// ── createTurnCollector ──────────────────────────────────────────────────────

test('createTurnCollector: 忽略 chunk、累加完整消息、按 turn 收尾', () => {
  const c = createTurnCollector();
  assert.equal(c.push({ type: 'turn/start', data: { turn: 't1' } }), null);
  assert.equal(c.push({ type: 'assistant/chunk', data: { turn: 't1', delta: 'X' } }), null);
  assert.equal(c.push({
    type: 'assistant/message',
    data: { turn: 't1', message: { content: [{ type: 'text', text: '你' }, { type: 'thinking', text: '别加' }, { type: 'text', text: '好' }] } },
  }), null);
  // 未知 turn 的完整消息不参与
  assert.equal(c.push({ type: 'assistant/message', data: { turn: 'tX', message: { content: [{ type: 'text', text: '幽灵' }] } } }), null);
  assert.equal(c.has('t1'), true);
  const ended = c.push({ type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } });
  assert.deepEqual(ended, { turn: 't1', reason: { kind: 'completed' }, text: '你好' });
  assert.equal(c.has('t1'), false);
  // 已收尾的 turn 再 end 一次不会凭空造结果
  assert.equal(c.push({ type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } }), null);
});

test('createTurnCollector: 多 turn 并行互不串文本', () => {
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 'a' } });
  c.push({ type: 'turn/start', data: { turn: 'b' } });
  c.push({ type: 'assistant/message', data: { turn: 'a', message: { content: [{ type: 'text', text: 'A' }] } } });
  c.push({ type: 'assistant/message', data: { turn: 'b', message: { content: [{ type: 'text', text: 'B' }] } } });
  assert.equal(c.push({ type: 'turn/end', data: { turn: 'a', reason: { kind: 'completed' } } }).text, 'A');
  assert.equal(c.push({ type: 'turn/end', data: { turn: 'b', reason: { kind: 'aborted' } } }).text, 'B');
  assert.equal(c.has('a') || c.has('b'), false);
});

// ── NodeApiClient：鉴权路径（不发网络） ───────────────────────────────────────

test('NodeApiClient: baseUrl 归一化 / resolveBase / 常量', async () => {
  await withEnv('DSH_HOME', caseDir(), () => {
    const c1 = new NodeApiClient('http://127.0.0.1:3080///', 5000, {});
    assert.equal(c1.baseUrl, 'http://127.0.0.1:3080');
    assert.equal(c1.resolveBase(), 'http://127.0.0.1:3080');
    const c2 = new NodeApiClient();
    assert.equal(c2.baseUrl, 'http://127.0.0.1:3080');
    assert.equal(FOLLOW_SNAPSHOT_MESSAGES, 200);
    assert.equal(MINTED_COOKIE_LIFETIME_MS, 60 * 60 * 1000);
  });
});

test('NodeApiClient.hasAuth: 显式 token 或可读密钥才算有鉴权', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, () => {
    assert.equal(new NodeApiClient('http://127.0.0.1:3080', 1000, {}).hasAuth(), false);
    assert.equal(new NodeApiClient('http://127.0.0.1:3080', 1000, { token: 'T'.repeat(20) }).hasAuth(), true);
  });
  const home2 = caseDir();
  writeCreds(home2, Buffer.alloc(32, 4));
  await withEnv('DSH_HOME', home2, () => {
    assert.equal(new NodeApiClient('http://127.0.0.1:3080', 1000, {}).hasAuth(), true);
  });
});

test('NodeApiClient.ensureAuth: 有密钥 + 回环地址 → 离线铸造并缓存', async () => {
  const home = caseDir();
  writeCreds(home, Buffer.alloc(32, 5));
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    const cookie = await client.ensureAuth();
    assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./);
    assert.equal(client._strategy, 'minted');
    assert.ok(client._cookieExpiresAt > Date.now());
    const again = await client.ensureAuth();
    assert.equal(again, cookie, '到期前应复用同一 Cookie');
  });
});

test('NodeApiClient.ensureAuth: 无 token 无密钥 → 明确报错，不偷偷联网', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    await assert.rejects(() => client.ensureAuth(), /DSH 鉴权不可用/);
    assert.equal(client.cookie, null);
  });
});

test('NodeApiClient.ensureAuth: 拒绝把 launch token 发往非回环地址', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://10.1.2.3:3080', 1000, { token: 'T'.repeat(20) });
    await assert.rejects(() => client.ensureAuth(), /拒绝把 DSH launch token 发往非本机地址/);
  });
  // 同地址有密钥也不能把本机密钥签的 Cookie 送去远程（canMint=false），仍应报鉴权不可用
  const home2 = caseDir();
  writeCreds(home2, Buffer.alloc(32, 6));
  await withEnv('DSH_HOME', home2, async () => {
    const client = new NodeApiClient('http://10.1.2.3:3080', 1000, {});
    await assert.rejects(() => client.ensureAuth(), /DSH 鉴权不可用/);
  });
});

test('NodeApiClient.invalidateAuth: 重新发现日志里的 token', async () => {
  const home = caseDir();
  writeLog(path.join(home, 'logs'), 'server-latest.out.log', 'http://127.0.0.1:3080/?token=DISCOVERED_TOKEN_123');
  await withEnv('DSH_HOME', home, async () => {
    await withEnv('DSH_LAUNCH_TOKEN', undefined, () => {
      const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
      assert.equal(client.launchToken, '');
      client.invalidateAuth();
      assert.equal(client.launchToken, 'DISCOVERED_TOKEN_123');
      assert.equal(client.hasAuth(), true);
    });
  });
});

test('NodeApiClient.events.follow/forget: 订阅集合先记账后重放', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    client.events.follow('s1');
    client.events.follow('s1');
    client.events.follow('');
    assert.deepEqual([...client._desiredFollows], ['s1']);
    client.events.forget('s1');
    client.events.forget('');
    assert.deepEqual([...client._desiredFollows], []);
  });
});

test('NodeApiClient.stopSessionWork: 缺 sessionId 直接拒绝', async () => {
  const home = caseDir();
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    await assert.rejects(() => client.stopSessionWork(''), /sessionId is required/);
  });
});

// ── NodeApiClient.callUnary：协议封装（fetch 桩，不走网络） ─────────────────────

test('NodeApiClient.callUnary: 斜杠 endpoint + { args } 包装 + Cookie 头', async () => {
  const home = caseDir();
  writeCreds(home, Buffer.alloc(32, 8));
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 2000, {});
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url: String(input), body, cookie: init.headers.get('cookie') });
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { echoed: true } } }),
      };
    };
    try {
      const res = await client.callUnary('session/list', { cursor: 'c1' });
      assert.deepEqual(res.result, { ok: true, value: { echoed: true } });
      const call = seen[0];
      assert.equal(call.url, 'http://127.0.0.1:3080/api/session/list');
      assert.equal(call.body.type, 'client-request');
      assert.equal(call.body.method, 'session/list');
      assert.deepEqual(call.body.payload, { args: { _request: { cursor: 'c1' } } });
      assert.match(call.cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./);

      await client.callUnary('session/rename', { sessionId: 's', title: 't' });
      assert.deepEqual(seen[1].body.payload, { args: { request: { sessionId: 's', title: 't' } } });
      assert.equal(seen[1].url, 'http://127.0.0.1:3080/api/session/rename');

      // wrapper 为 null 的 endpoint：不传 payload
      await client.callUnary('agentPresets.list', { ignored: true });
      assert.equal(seen[2].url, 'http://127.0.0.1:3080/api/agentPresets/list');
      assert.deepEqual(seen[2].body.payload, { args: {} });

      // 未登记的 endpoint：body 直接进 args
      await client.callUnary('workspace/rename', { sessionId: 's', title: 'x' });
      assert.deepEqual(seen[3].body.payload, { args: { request: { sessionId: 's', title: 'x' } } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('NodeApiClient.callUnary: session/prompt 自动补 requestId，已带则保留', async () => {
  const home = caseDir();
  writeCreds(home, Buffer.alloc(32, 8));
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 2000, {});
    const prompts = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init.body));
      prompts.push(body.payload.args.request);
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } }),
      };
    };
    try {
      await client.callUnary('session/prompt', { sessionId: 's', content: [] });
      assert.match(prompts[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      await client.callUnary('session/prompt', { sessionId: 's', requestId: 'fixed-id', content: [] });
      assert.equal(prompts[1].requestId, 'fixed-id');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('NodeApiClient.callUnary: 非法信封与传输失败都抛错', async () => {
  const home = caseDir();
  writeCreds(home, Buffer.alloc(32, 8));
  await withEnv('DSH_HOME', home, async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 2000, {});
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ type: 'nope' }),
      });
      await assert.rejects(() => client.callUnary('session/list', {}), /invalid server-response for session\/list/);

      globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      await assert.rejects(() => client.callUnary('session/list', {}), /transport failure for \/api\/session\/list: HTTP 500/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
