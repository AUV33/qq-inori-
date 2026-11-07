// state-acl 金标：回读判定必须排除 Mandatory Label，否则「已收紧」被误判成「未收紧」→ 反复重跑破坏性命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasInheritedPermissionAce, hasPermissiveTrustee, manualDirCommand,
} from '../src/domain/shared/state-acl.mjs';

test('hasInheritedPermissionAce：权限 ACE 带 (I) 才算继承', () => {
  const out = [
    'C:\\qq-inori\\qq-bridge\\state BUILTIN\\Administrators:(F)',
    '                                BUILTIN\\Users:(RX)',
  ].join('\r\n');
  assert.equal(hasInheritedPermissionAce(out), false);
  assert.equal(hasInheritedPermissionAce(`${out}\r\n                NT AUTHORITY\\SYSTEM:(OI)(CI)(IO)(F)`), false, '没有 (I) 的显式 ACE 不算');
  assert.equal(hasInheritedPermissionAce('C:\\state DOMAIN\\u:(I)(OI)(CI)(F)'), true);
});

test('hasInheritedPermissionAce：Mandatory Label 行永远带 (I)，必须排除掉', () => {
  const hardened = [
    'C:\\qq-inori\\qq-bridge\\state USER:(OI)(CI)(F)',
    '                                NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '                                Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)',
  ].join('\r\n');
  assert.equal(hasInheritedPermissionAce(hardened), false, '低完整性标签不是权限继承');
  assert.equal(hasInheritedPermissionAce('Mandatory Label\\Medium Mandatory Level:(I)(NW)'), false);
});

test('hasInheritedPermissionAce：空/异常输入安全返回 false', () => {
  assert.equal(hasInheritedPermissionAce(''), false);
  assert.equal(hasInheritedPermissionAce(null), false);
  assert.equal(hasInheritedPermissionAce(undefined), false);
});

test('hasPermissiveTrustee：认出任意用户可读的宽松主体', () => {
  assert.equal(hasPermissiveTrustee('NT AUTHORITY\\Authenticated Users:(RX)'), true);
  assert.equal(hasPermissiveTrustee('BUILTIN\\Users:(OI)(CI)(RX)'), true);
  assert.equal(hasPermissiveTrustee('Everyone:(F)'), true);
  assert.equal(hasPermissiveTrustee('USER:(OI)(CI)(F)\r\nNT AUTHORITY\\SYSTEM:(F)'), false);
  assert.equal(hasPermissiveTrustee(''), false);
});

test('manualDirCommand：四步安全序列，且绝不把 (OI)(CI) 与 /T 写进同一句', () => {
  const cmd = manualDirCommand('C:/qq-inori/qq-bridge/state');
  const lines = cmd.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /\/inheritance:r/);
  assert.match(lines[1], /\/remove:g .*\/T/);
  assert.match(lines[2], /\/T .*\/grant/);
  assert.match(lines[3], /\(OI\)\(CI\)F/);
  assert.ok(!/\/T/.test(lines[3]), '最后那步补可继承 ACE 时不能带 /T（会把子文件 DACL 清空）');
  assert.ok(lines[1].includes('*S-1-5-11') && lines[1].includes('*S-1-5-32-545') && lines[1].includes('*S-1-1-0'), '按 SID 删，不受系统语言影响');
});

test('manualDirCommand：非 Windows 给 chmod 版本', () => {
  if (process.platform === 'win32') return; // 只在类 Unix 上验
  assert.match(manualDirCommand('/tmp/state'), /^chmod -R go-rwx/);
});
