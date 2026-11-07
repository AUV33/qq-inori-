import { readBridgeSource } from './lib/bridge-source.mjs';
// test-mute-skip.mjs · 禁言期间不投递（静态接线锁 + 行为语义）
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const src = readBridgeSource();

check('禁言跳过模块存在（[MUTE-SKIP]）', () => {
  assert.ok(src.includes('[MUTE-SKIP]'), '没有 [MUTE-SKIP]');
  assert.ok(src.includes('groupMutedUntil('), '没有 groupMutedUntil');
  assert.ok(src.includes('muteSkip('), '没有 muteSkip');
});

check('三条发送路径都有禁言检查', () => {
  const guards = (src.match(/kind === 'group' && await groupMutedUntil\(id\)/g) || []).length;
  assert.ok(guards >= 3, `只有 ${guards} 条路径带禁言检查`);
});

check('禁言全跳过时不抛错（不把发送失败投给她）', () => {
  assert.ok(src.includes('allMuted'), '没有 allMuted 分支');
  assert.ok(src.includes('未投递（不报错）'), '没有免报错日志');
});

check('禁言到期时间从 shut_up_timestamp 取（秒 → 毫秒）', () => {
  assert.ok(src.includes('shut_up_timestamp'), '没有读 shut_up_timestamp');
  assert.ok(src.includes('* 1000'), '没有秒转毫秒');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
