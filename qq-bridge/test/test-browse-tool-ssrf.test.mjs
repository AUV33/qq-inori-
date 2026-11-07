// browse-tool SSRF 收口：assertPublicUrl 拦截内网/环回/链路本地/元数据地址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, ipIsPublic } from '../../ai-companion-kit/packages/memory-mcp/src/browse-tool.js';

// 解析桩：对齐 ssrf-safe.resolveSafeHost 的契约（Promise + 全地址数组，与 dns.promises.lookup 一致）。
// 旧版是回调式单地址（存在 TOCTOU 缺口），修复后要求"全部解析结果都公网"才放行。
const lookup = async (host, opts = {}) => {
  const table = {
    'example.com': '203.0.113.10',
    'api.douban.com': '203.0.113.20',
    'localhost': '127.0.0.1',
    'internal.host': '10.0.0.5',
    'meta': '169.254.169.254',
    'priv': '192.168.1.1',
    'cgn': '100.64.0.1',
    'v6local': 'fe80::1',
  };
  const addr = table[host];
  if (!addr) throw new Error('ENOTFOUND');
  return [{ address: addr, family: addr.includes(':') ? 6 : 4 }];
};

test('ipIsPublic：公网为真，私有为假', () => {
  assert.equal(ipIsPublic('203.0.113.10'), true);
  assert.equal(ipIsPublic('8.8.8.8'), true);
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.5.5', '172.31.255.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    assert.equal(ipIsPublic(ip), false, `${ip} 应判为私有`);
  }
  assert.equal(ipIsPublic('::1'), false);
  assert.equal(ipIsPublic('fe80::1'), false);
  assert.equal(ipIsPublic('fd00::1'), false);
});

test('assertPublicUrl：公网网址放行', async () => {
  const r = await assertPublicUrl('https://example.com/posts/1', { lookup });
  assert.equal(r, 'https://example.com/posts/1');
});

test('assertPublicUrl：内网/环回/元数据/私有主机全被拒', async () => {
  const bad = [
    'http://127.0.0.1:3100/admin',
    'http://localhost:8080/x',
    'http://10.0.0.5/secret',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://[fe80::1]/',
    'ftp://example.com/x',
    'not-a-url',
  ];
  for (const url of bad) {
    await assert.rejects(() => assertPublicUrl(url, { lookup }), /(内网|环回|localhost|http\/https|合法网址|元数据|SSRF)/, `${url} 应被拒`);
  }
});
