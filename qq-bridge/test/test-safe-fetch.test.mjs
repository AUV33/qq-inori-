// safe-fetch 金标：SSRF 防线——私网/环回/链路本地/CGNAT/IPv4-mapped/NAT64/6to4 一律拦，URL 只许 http(s) 且无凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, resolveSafeHost, validateFetchUrl, looksLikeImageBuffer } from '../src/domain/shared/safe-fetch.js';

test('isPrivateIp：IPv4 私网与保留段全部拦下', () => {
  for (const ip of [
    '10.0.0.1', '10.255.255.255',
    '127.0.0.1', '127.1.2.3',
    '0.0.0.0', '0.1.2.3',
    '169.254.1.1',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', '100.127.255.255',
    '198.18.0.1', '198.19.255.255',
    '192.0.0.1',
    '224.0.0.1', '239.255.255.250', '255.255.255.255',
  ]) assert.equal(isPrivateIp(ip), true, ip);
});

test('isPrivateIp：公网 IPv4 放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '203.0.113.1']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp：非法/空/带 zone id 一律当内网（不能把非法地址当公网）', () => {
  for (const ip of ['', null, 'not-an-ip', '999.1.1.1', 'fe80::1%eth0']) {
    assert.equal(isPrivateIp(ip), true, String(ip));
  }
});

test('isPrivateIp：IPv6 私网/保留段', () => {
  for (const ip of [
    '::', '::1',
    'fc00::1', 'fd12:3456::1',
    'fe80::1', 'fe9f::1', 'feb0::1',
    'fec0::1', 'fed0::1',
    '64:ff9b:1::1',
    '2001:db8::1',
    '2001:2::1', '2001:10::1', '2001:20::1',
    'ff02::1',
  ]) assert.equal(isPrivateIp(ip), true, ip);
});

test('isPrivateIp：IPv6 公网放行', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp：IPv4-mapped / compatible / NAT64 里的内网地址要递归拦', () => {
  for (const ip of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::c0a8:101',
    '64:ff9b::c0a8:101',
    '64:ff9b::7f00:1',
  ]) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false, '映射的公网地址应放行');
});

test('isPrivateIp：6to4（2002::/16）里嵌的私网地址要拦', () => {
  assert.equal(isPrivateIp('2002:c0a8:101::1'), true, '2002:192.168.1.1');
  assert.equal(isPrivateIp('2002:808:808::1'), false, '2002:8.8.8.8');
});

test('isPrivateIp：方括号包裹的 IPv6 也能判', () => {
  assert.equal(isPrivateIp('[::1]'), true);
  assert.equal(isPrivateIp('[2606:4700:4700::1111]'), false);
});

test('isPrivateIp：非压缩全零/全一环回应归一到 :: / ::1 并拦截', () => {
  // B3 回归：未规范化的写法不能绕过 h === '::' / '::1' 的精确匹配打到本机环回。
  for (const ip of ['0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('resolveSafeHost：本机/内网域名直接拒绝，空主机名也拒绝', async () => {
  for (const host of ['localhost', 'a.localhost', 'printer.local', '']) {
    await assert.rejects(() => resolveSafeHost(host), /禁止访问内网\/本机地址|主机名为空/, host);
  }
});

test('resolveSafeHost：IP 字面量不走 DNS——私网拒绝、公网原样返回', async () => {
  await assert.rejects(() => resolveSafeHost('127.0.0.1'), /禁止访问内网/);
  await assert.rejects(() => resolveSafeHost('192.168.1.1'), /禁止访问内网/);
  assert.equal(await resolveSafeHost('8.8.8.8'), '8.8.8.8');
  assert.equal(await resolveSafeHost('[2606:4700:4700::1111]'), '2606:4700:4700::1111', '去掉方括号');
});

test('validateFetchUrl：只允许 http/https、不允许凭据、私网 IP 拒绝', async () => {
  await assert.rejects(() => validateFetchUrl('ftp://example.com/x'), /仅允许 http\/https/);
  await assert.rejects(() => validateFetchUrl('file:///etc/passwd'), /仅允许 http\/https/);
  await assert.rejects(() => validateFetchUrl('http://user:pass@8.8.8.8/'), /不能包含凭据/);
  await assert.rejects(() => validateFetchUrl('http://127.0.0.1/x'), /禁止访问内网/);
  await assert.rejects(() => validateFetchUrl('不是 URL'), /URL 无效/);
  await assert.rejects(() => validateFetchUrl(''), /URL 无效/);

  const ok = await validateFetchUrl('https://8.8.8.8/path?q=1');
  assert.equal(ok.ip, '8.8.8.8');
  assert.equal(ok.url.pathname, '/path');
});

test('looksLikeImageBuffer：只认 PNG/JPEG/GIF/WebP，太短或其它返回 false', () => {
  assert.equal(looksLikeImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(looksLikeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(looksLikeImageBuffer(Buffer.from('GIF89a______', 'ascii')), true);
  assert.equal(looksLikeImageBuffer(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), true);
  assert.equal(looksLikeImageBuffer(Buffer.from('<!doctype html>')), false, 'HTML 不是图片');
  assert.equal(looksLikeImageBuffer(Buffer.from([1, 2, 3])), false, '太短');
  assert.equal(looksLikeImageBuffer(null), false);
});
