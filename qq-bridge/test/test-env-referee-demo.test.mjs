// test-env-referee-demo.test.mjs · S9c：可复现 demo（不连设备）证明原子三元组与熔断真的工作。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/env-referee-demo.mjs');

test('demo：盲操作 invalid、连续失败触发 stuck、正确动作 met、自检通过', () => {
  const out = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.simulated, true, '必须明确是模拟，不冒充真机');
  assert.equal(body.summary.passed, true);
  assert.equal(body.steps.find((s) => s.name === 'blind-action').result, 'invalid');
  assert.equal(body.steps.filter((s) => s.name.startsWith('wrong-')).every((s) => s.result === 'not_met'), true);
  assert.equal(body.stuck.stuck, true);
  assert.equal(body.summary.met, 2);

  const human = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /模拟 adb 部署/);
  assert.match(human.stdout, /自检=通过/);
});
