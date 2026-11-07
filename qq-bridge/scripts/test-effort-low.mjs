import { readBridgeSource } from './lib/bridge-source.mjs';
// test-effort-low.mjs · 所有会话默认思考档 = low
import assert from 'node:assert';
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const cfg = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/config.json`, 'utf8'));
const bridge = readBridgeSource();

check('config：默认思考档 low（任务池也 low）', () => {
  assert.equal(cfg.dsh?.reasoningEffort, 'low');
  assert.equal(cfg.socialV2?.taskPool?.reasoningEffort, 'low');
});

check('bridge：隔离会话每次投递补 ensureChatModel（已存在会话也能到 low）', () => {
  assert.ok(bridge.includes('[EFFORT-ALL]'), '缺少 EFFORT-ALL 标记');
  assert.ok(bridge.includes('await ensureChatModel(sessionId);'), '投递前没确保模型档');
});

check('迁移脚本存在', () => {
  assert.ok(fs.existsSync(`${PROJECT_ROOT}/qq-bridge/scripts/set-effort-low.mjs`));
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
