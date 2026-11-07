import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStartupFingerprint,
  formatFingerprint,
  readConfigSha,
  readGitRev,
  resolveLaunchSource,
  sha1Short,
  UNKNOWN,
} from '../src/domain/shared/startup-fingerprint.js';

test('sha1Short：已知向量 + 可指定截断长度', () => {
  assert.equal(sha1Short('abc'), 'a9993e36');
  assert.equal(sha1Short(Buffer.from('abc'), 12).length, 12);
});

test('readGitRev：正常取短哈希并去空白', () => {
  assert.equal(readGitRev({ root: 'D:/x', exec: () => '1695739\n' }), '1695739');
});

test('readGitRev：-dirty 后缀取哈希部分', () => {
  assert.equal(readGitRev({ root: 'D:/x', exec: () => '1695739-dirty\n' }), '1695739');
});

test('readGitRev：命令失败 / 非哈希输出 / 没给 root → unknown', () => {
  assert.equal(readGitRev({ root: 'D:/x', exec: () => { throw new Error('not a repo'); } }), UNKNOWN);
  assert.equal(readGitRev({ root: 'D:/x', exec: () => 'fatal: not a git repository' }), UNKNOWN);
  assert.equal(readGitRev({}), UNKNOWN);
});

test('readConfigSha：缺文件 → unknown；能读时是 sha1 前 8 位', () => {
  assert.equal(readConfigSha({}), UNKNOWN);
  assert.equal(readConfigSha({ configPath: 'x', readFile: () => { throw new Error('ENOENT'); } }), UNKNOWN);
  assert.equal(readConfigSha({ configPath: 'x', readFile: () => '{"a":1}' }), sha1Short('{"a":1}'));
});

test('resolveLaunchSource：默认 manual，白名单外 → unknown', () => {
  assert.equal(resolveLaunchSource({}), 'manual');
  assert.equal(resolveLaunchSource({ BRIDGE_LAUNCH_SOURCE: '' }), 'manual');
  assert.equal(resolveLaunchSource({ BRIDGE_LAUNCH_SOURCE: 'watchdog-vbs' }), 'watchdog-vbs');
  assert.equal(resolveLaunchSource({ BRIDGE_LAUNCH_SOURCE: 'Watchdog-Direct' }), 'watchdog-direct');
  assert.equal(resolveLaunchSource({ BRIDGE_LAUNCH_SOURCE: 'evil; rm -rf' }), UNKNOWN);
});

test('buildStartupFingerprint：注入依赖组装齐全，任一项失败只降级该项', () => {
  const fp = buildStartupFingerprint({
    root: 'D:/x',
    configPath: 'cfg',
    env: { BRIDGE_LAUNCH_SOURCE: 'restart' },
    exec: () => 'abcdef1\n',
    readFile: () => 'cfg-body',
  });
  assert.deepEqual(fp, { rev: 'abcdef1', cfg: sha1Short('cfg-body'), src: 'restart' });

  const degraded = buildStartupFingerprint({
    env: {},
    exec: () => { throw new Error('x'); },
    readFile: () => { throw new Error('x'); },
  });
  assert.deepEqual(degraded, { rev: UNKNOWN, cfg: UNKNOWN, src: 'manual' });
});

test('formatFingerprint：单行三字段，缺值降级 unknown', () => {
  assert.equal(formatFingerprint({ rev: 'r1', cfg: 'c2', src: 'manual' }), 'rev=r1 cfg=c2 src=manual');
  assert.equal(formatFingerprint({}), 'rev=unknown cfg=unknown src=unknown');
});
