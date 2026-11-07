// browse-tool / ssrf-safe SSRF 回归测试（不依赖真网、不依赖 zod）
//
// 重点：验证修复后不再存在 DNS-rebinding(TOCTOU) 缺口——
//   1) 私网/环回/元数据地址被拒（IP 字面量与解析结果双路径）；
//   2) 域名解析结果【全部】须为公网，任一为私网即拒；
//   3) 通过校验后连接的是【已校验 IP】，而非重新解析域名（结构保证，见 ssrf-safe.requestOnce）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, resolveSafeHost, validateFetchUrl, safeFetch } from '../src/ssrf-safe.js';
import { registerBrowseTool, assertPublicUrl, SOURCES, canUseEdgeRenderer, readPage } from '../src/browse-tool.js';

// 递归桩：满足 z.string().optional().describe(...) 这类链式调用，免去对 zod 的依赖。
const zStub = new Proxy(function () {}, { get: () => zStub, apply: () => zStub });
const z = zStub;

test('isPrivateIp 覆盖私网/公网边界', () => {
  const priv = [
    '127.0.0.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    '192.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '2001:db8::1',
    '::ffff:127.0.0.1', '64:ff9b::c0a8:101',
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `应判私网: ${ip}`);
  const pub = ['8.8.8.8', '1.1.1.1', '203.0.113.5', '9.255.255.254', '2001:4860:4860::8888'];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `应判公网: ${ip}`);
});

test('resolveSafeHost 域名解析结果全部为公网才放行，任一私网即拒（lookup 注入）', async () => {
  const mixed = async (h, opts) => [{ address: '1.2.3.4' }, { address: '127.0.0.1' }];
  await assert.rejects(() => resolveSafeHost('x.test', { lookup: mixed }), /内网|私有/);
  const pubOnly = async (h, opts) => [{ address: '1.2.3.4' }];
  assert.equal(await resolveSafeHost('x.test', { lookup: pubOnly }), '1.2.3.4');
});

test('assertPublicUrl 注入 lookup：解析到私网即拒，公网通过', async () => {
  const priv = async (h, opts) => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(() => assertPublicUrl('http://evil.test/', { lookup: priv }), /内网|私有|SSRF|禁止/);
  const pub = async (h, opts) => [{ address: '1.2.3.4', family: 4 }];
  assert.equal(await assertPublicUrl('http://example.test/', { lookup: pub }), 'http://example.test/');
  await assert.rejects(() => assertPublicUrl('ftp://example.test/'), /http/);
  await assert.rejects(() => assertPublicUrl('http://u:p@example.test/'), /凭据/);
});

test('safeFetch 拒绝私网 IP 字面量（端到端，无需 DNS）', async () => {
  await assert.rejects(() => safeFetch('http://127.0.0.1:9/'), /内网|私有|SSRF|禁止/);
  await assert.rejects(() => safeFetch('http://169.254.169.254/latest/meta-data/'), /内网|私有|SSRF|禁止/);
});

test('browse_posts 端到端拒绝私网地址（经 safeFetch 全链路）', async () => {
  let handler = null;
  const calls = { tool: (_n, _d, _s, h) => { handler = h; } };
  let failed = null, replied = null;
  const reply = (s) => { replied = s; return {}; };
  const fail = (s) => { failed = s; return { isError: true }; };
  await registerBrowseTool(calls, { z, reply, fail });
  assert.ok(handler, 'handler 应已注册');

  await handler({ url: 'http://127.0.0.1:3100/' });
  assert.ok(failed, `私网控制台地址应被拦截，实际 reply=${replied}`);
  assert.match(failed, /不能访问|内网|SSRF|禁止/);

  failed = null; replied = null;
  await handler({ url: 'http://169.254.169.254/latest/meta-data/' });
  assert.ok(failed, `云元数据地址应被拦截，实际 reply=${replied}`);
});

// ── 原 Phase 2-H 的三个 todo 覆盖缺口，现用可注入的 lookup / request / render 桩补齐 ──
// 注入只替换「解析」与「传输」两端，不碰任何私网判定逻辑；生产不传 opts 时路径不变。

test('safeFetch 应拒绝重定向到私网的响应（每跳重校验）', async () => {
  const seen = [];
  const lookup = async () => [{ address: '1.2.3.4', family: 4 }];
  const request = async (url, ip) => {
    seen.push({ href: url.toString(), ip });
    return { statusCode: 302, redirect: 'http://127.0.0.1:9/admin' };
  };
  await assert.rejects(
    () => safeFetch('http://public.example/', 50000, { lookup, request }),
    /内网|本机地址|私有/,
  );
  assert.equal(seen.length, 1, '第一跳之后就该被拦下，绝不发起指向内网的第二跳');
  assert.equal(seen[0].ip, '1.2.3.4');
});

test('Edge 渲染仅白名单源：自定义 URL 不进入渲染进程（避免触达内网）', async () => {
  assert.equal(canUseEdgeRenderer(SOURCES[0]), true);
  for (const evil of [
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'https://www.douban.com/group/explore?tag=x', // 带 query 也不算白名单
  ]) {
    assert.equal(canUseEdgeRenderer(evil), false, `${evil} 不得放行渲染`);
  }
  const renders = [];
  const opts = {
    fetchPage: async () => ({ body: '<html><head><title>t</title></head><body>short</body></html>' }),
    render: async (url) => { renders.push(url); return `<html><body>${'x'.repeat(400)}</body></html>`; },
  };
  await readPage('http://192.168.1.1/evil', opts);
  assert.equal(renders.length, 0, '自定义/内网 URL 不得启动 Edge 渲染进程');
  const page = await readPage(SOURCES[0], opts);
  assert.equal(renders.length, 1, '只有白名单固定源才允许渲染');
  assert.equal(page.rendered, true);
});

test('云元数据经 DNS-rebinding（先公网、连接时重解析为私网）仍被连 IP 策略拦下', async () => {
  let validateCalls = 0;
  let attackerResolutions = 0;
  const lookup = async () => {
    validateCalls += 1;
    return [{ address: '1.2.3.4', family: 4 }];
  };
  const attackerLookup = async () => {
    attackerResolutions += 1;
    return [{ address: '169.254.169.254', family: 4 }];
  };
  const seen = [];
  const request = async (url, ip) => {
    const rebound = await attackerLookup(); // 模拟连接在即时域名被重新解析到云元数据
    seen.push({ hostname: url.hostname, ip, rebound: rebound[0].address });
    return { statusCode: 200, body: 'ok', truncated: false };
  };
  const r = await safeFetch('http://metadata.example/latest/meta-data/', 50000, { lookup, request });
  assert.equal(r.statusCode, 200);
  assert.equal(validateCalls, 1, '校验阶段只解析一次');
  assert.equal(attackerResolutions, 1, '攻击者确实在连接时完成了二次解析');
  assert.equal(seen[0].ip, '1.2.3.4', '传输层拿到的必须是首次校验通过的公网 IP，而非二次解析结果');
  assert.equal(seen[0].hostname, 'metadata.example', 'Host/SNI 仍保留原域名');
  assert.equal(seen[0].rebound, '169.254.169.254', '二次解析确实变成了私网，证明 TOCTOU 窗口存在但未被利用');

  // 另一半：若校验阶段就解析到私网，连第一跳都不该发出。
  let sent = false;
  await assert.rejects(
    () => safeFetch('http://metadata.example/', 50000, {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      request: async () => { sent = true; throw new Error('不应发起请求'); },
    }),
    /内网|本机地址|私有/,
  );
  assert.equal(sent, false);
});

