import { readBridgeSource } from './lib/bridge-source.mjs';
// test-preset-safety.mjs · 权限边界：群聊/外人私聊/群 owner lane = v2；主人私聊/任务/她的时间（ownlife/diary/reflect）= admin
import assert from 'node:assert';
import fs from 'node:fs';
import { isolatedPresetFor } from '../src/domain/leaves/inori-isolated-preset.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const cfg = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/config.json`, 'utf8'));
const bridge = readBridgeSource();

check('群聊/外人私聊的 preset 是 qq-chat-v2（无本地执行）', () => {
  assert.equal(cfg.socialV2?.agentPreset, 'qq-chat-v2');
});

check('bridge：只有 owner 私聊强制 admin；群 owner lane 绝不挂 admin（群内容不可信）', () => {
  assert.ok(bridge.includes("const admin = resolvePresetName('qq-chat-admin');"), '缺 admin 解析');
  assert.ok(bridge.includes("if (mode === 'reserved2' && ownerPrivate)"), 'owner 私聊 admin 分支丢了');
  assert.ok(!bridge.includes("ownerPrivate || isOwnerLaneKey(key)"), '群 owner lane 不应再挂 admin preset');
});

check('任务会话与她的时间（ownlife/diary/reflect）仍是 admin', () => {
  assert.equal(cfg.socialV2?.taskPool?.preset, 'qq-chat-admin');
  assert.equal(isolatedPresetFor('ownlife', cfg), 'qq-chat-admin');
  assert.equal(isolatedPresetFor('diary', cfg), 'qq-chat-admin');
  assert.equal(isolatedPresetFor('reflect', cfg), 'qq-chat-admin');
});

check('gate 仍是 qq-gate，其他隔离会话仍是 v1', () => {
  assert.equal(isolatedPresetFor('gate', cfg), 'qq-gate');
  assert.equal(isolatedPresetFor('intake', cfg), 'qq-chat');
  assert.equal(isolatedPresetFor('vision', cfg), 'qq-chat');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
