// inori-skill-verify 金标：判据解析（文件/网址/命令/文字）与机检结果。
// [AUDIT-FIX] 安全收敛后同步更新：叶子层不再执行 shell、url 走统一 SSRF 防护、
// file 只允许注入的 roots。抓取与根目录均可注入，测试不发真实网络请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifySpec, checkVerify } from '../src/domain/leaves/inori-skill-verify.js';

test('parseVerifySpec：四种前缀，中英文冒号都认', () => {
  assert.deepEqual(parseVerifySpec('文件:D:/x/y.txt'), { type: 'file', target: 'D:/x/y.txt', raw: '文件:D:/x/y.txt' });
  assert.equal(parseVerifySpec('路径：C:/a').type, 'file');
  assert.equal(parseVerifySpec('file: /tmp/a').type, 'file');
  assert.equal(parseVerifySpec('网址: https://example.com/ok').type, 'url');
  assert.equal(parseVerifySpec('链接：https://a.b/c').type, 'url');
  assert.equal(parseVerifySpec('命令: echo hi').type, 'cmd');
  assert.equal(parseVerifySpec('cmd：dir').type, 'cmd');
  assert.equal(parseVerifySpec('她说做完了就行').type, 'text');
  assert.deepEqual(parseVerifySpec(null), { type: 'text', target: '', raw: '' });
});

test('checkVerify：文件判据——roots 内存在即通过，roots 外被拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skillverify-'));
  try {
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, '12345');
    const opts = { allowedRoots: [dir] };

    const ok = await checkVerify(`文件:${file}`, opts);
    assert.equal(ok.ok, true);
    assert.equal(ok.type, 'file');
    assert.match(ok.evidence, /文件存在（5 B）/);

    const dirResult = await checkVerify(`文件:${dir}`, opts);
    assert.equal(dirResult.ok, true);
    assert.equal(dirResult.evidence, '目录存在');

    const missing = await checkVerify(`文件:${path.join(dir, 'nope.txt')}`, opts);
    assert.equal(missing.ok, false);
    assert.equal(missing.evidence, '路径不存在');

    // 未注入 root 的任意绝对路径必须被挡住，不能探测项目外的文件是否存在。
    const outside = await checkVerify(`文件:${file}`);
    assert.equal(outside.ok, false);
    assert.match(outside.evidence, /不在允许目录内/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkVerify：网址判据——状态 <400 通过，>=400 失败，抛错说明原因', async () => {
  const ok = await checkVerify('网址: https://example.com/ok', {
    fetchImpl: async () => ({ statusCode: 200 }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.evidence, 'HTTP 200');

  const notFound = await checkVerify('url: https://example.com/x', {
    fetchImpl: async () => ({ statusCode: 404 }),
  });
  assert.equal(notFound.ok, false);

  const bad = await checkVerify('网址: https://down.example', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.evidence, /请求失败：ECONNREFUSED/);
});

test('checkVerify：命令判据一律不执行（包括 allowCommand=true）', async () => {
  const r = await checkVerify('命令: echo should-not-run');
  assert.equal(r.ok, null);
  assert.equal(r.type, 'cmd');
  assert.match(r.evidence, /不机检/);

  // 技能文本是不可信输入：即使调用方显式打开旧开关，也不能变回任意命令执行。
  const forced = await checkVerify('命令: Write-Output pwned', { allowCommand: true, timeoutMs: 15000 });
  assert.equal(forced.ok, null);
  assert.match(forced.evidence, /不机检/);
  assert.doesNotMatch(forced.evidence, /exit /);
});

test('checkVerify：叶子模块不含命令执行与裸 fetch 出口', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/domain/leaves/inori-skill-verify.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /node:child_process|execFile\(/);
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.match(src, /safe-fetch\.js/);
});

test('checkVerify：文字判据不机检（ok=null）', async () => {
  const r = await checkVerify('她说好看就行');
  assert.equal(r.ok, null);
  assert.equal(r.type, 'text');
  assert.match(r.evidence, /无法机检/);
  assert.equal((await checkVerify('')).ok, null);
});
