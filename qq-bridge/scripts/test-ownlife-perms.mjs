import { readBridgeSource } from './lib/bridge-source.mjs';
// test-ownlife-perms.mjs · A：自由时间（ownlife/free-tick）上任务级 preset（全本地工具）
import assert from 'node:assert';
import fs from 'node:fs';
import { isolatedPresetFor } from '../src/domain/leaves/inori-isolated-preset.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const bridge = readBridgeSource();

check('纯函数实测：gate→qq-gate；ownlife/diary/reflect→任务级（她的时间全权限）', () => {
  const cfg = { socialV2: { taskPool: { preset: 'custom-admin' } } };
  assert.equal(isolatedPresetFor('gate', cfg), 'qq-gate');
  assert.equal(isolatedPresetFor('ownlife', cfg), 'custom-admin');
  assert.equal(isolatedPresetFor('diary', cfg), 'custom-admin');
  assert.equal(isolatedPresetFor('reflect', cfg), 'custom-admin');
  assert.equal(isolatedPresetFor('ownlife', {}), 'qq-chat-admin');
});

check('bridge 使用该模块，没有在顶层写 export（vm harness 会炸）', () => {
  assert.ok(bridge.includes("from './inori-isolated-preset.js'"), '没有导入模块');
  assert.ok(bridge.includes('const gatePreset = isolatedPresetFor(kind, cfgRef);'), 'ensureIsolatedSession 没用它');
  assert.ok(!bridge.includes('export function isolatedPresetFor'), 'bridge 顶层还留着 export');
});

check('旧 preset 的隔离会话会归档重建（任何 kind 变了都重建）', () => {
  assert.ok(bridge.includes('saved.preset && saved.preset !== gatePreset'), '缓存未按 preset 重建');
  assert.ok(bridge.includes('旧会话 preset='), '没有重建日志');
});

check('任务池 preset：主人私聊来的任务 admin，其他人/群来的任务 v2', () => {
  assert.ok(bridge.includes('const fromOwner = !!ownerRequested || (Boolean(reportTo) && String(reportTo) === ownerKey);'), '缺少来源判定');
  assert.ok(bridge.includes("? (cfgRef?.socialV2?.taskPool?.preset || 'qq-chat-admin')"), '主人任务不是 admin');
  assert.ok(bridge.includes(": (cfgRef?.socialV2?.agentPreset || 'qq-chat-v2')"), '非主人任务不是 v2');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
