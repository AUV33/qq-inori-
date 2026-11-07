// test-owner-model-wiring.test.mjs · S10e：偏好从 memory_save 进入 owner-model，并进唤醒提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('memory_save：owner 私聊 pinned 事实会写 owner-model；失败不挡记忆', () => {
  const src = read('ai-companion-kit/packages/memory-mcp/src/memory-mcp.js');
  assert.match(src, /extractPreference/);
  assert.match(src, /createOwnerModelStore/);
  assert.match(src, /owner-model\.jsonl/);
  assert.match(src, /crypto\.createHash\('sha1'\)/, 'evidenceId 必须用正文摘要，不能靠分钟+长度');
  assert.match(src, /P\.scope === 'private' && pin\?\.pinned === true/);
  const check = spawnSync(process.execPath, ['--check', path.join(REPO, 'ai-companion-kit/packages/memory-mcp/src/memory-mcp.js')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(check.status, 0, check.stderr);
});

test('唤醒提示：owner 偏好有一行，且不是命令', () => {
  const svc = read('qq-bridge/src/domain/conversation/wake-prompt-service.mjs');
  assert.match(svc, /renderOwnerModelLine/);
  assert.match(svc, /mindOwnerModelLine/);
  const wp = read('qq-bridge/src/domain/persona/wake-prompt.mjs');
  assert.match(wp, /mindOwnerModelLine/);
  const app = read('qq-bridge/src/app.mjs');
  assert.match(app, /getMindOwnerModel/);
});
