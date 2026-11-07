// test-living-eval.test.mjs · M4/G10：30 场景回归集 + 风格指纹漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  evaluateScenario, runLivingEval, styleFingerprint, styleDrift,
} from '../scripts/lib/living-eval.mjs';
import { LIVING_EVAL_SCENARIOS } from '../scripts/lib/living-eval-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('场景集：30 个、id 唯一、每条都有期望', () => {
  assert.equal(LIVING_EVAL_SCENARIOS.length, 30);
  assert.equal(new Set(LIVING_EVAL_SCENARIOS.map((s) => s.id)).size, 30);
  for (const s of LIVING_EVAL_SCENARIOS) {
    assert.ok(s.expect && Object.keys(s.expect).length > 0, s.id);
  }
});

test('断言器：不符要失败并指出字段；缺省字段不误杀', () => {
  const bad = evaluateScenario({ id: 'x', expect: { addressee: 'her', move: 'reply' } }, { addressee: 'other', move: 'silence' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures.map((f) => f.field).sort(), ['addressee', 'move']);
  const partial = evaluateScenario({ id: 'y', expect: { move: 'reply' } }, { addressee: 'other', move: 'reply' });
  assert.equal(partial.ok, true);
  const amb = evaluateScenario({ id: 'z', expect: { maxAmbiguity: 0.2 } }, { ambiguity: 0.7 });
  assert.equal(amb.ok, false);
});

test('全量：跑到异常也计入失败，不炸整轮', () => {
  const report = runLivingEval({
    scenarios: [{ id: 'ok', expect: { move: 'reply' } }, { id: 'boom', expect: { move: 'reply' } }],
    runner: (s) => { if (s.id === 'boom') throw new Error('runner 崩了'); return { move: 'reply' }; },
  });
  assert.equal(report.total, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.rows.find((r) => r.id === 'boom').failures[0].field, 'runner');
});

test('风格指纹与漂移：同风格不漂，明显变化会报 drift', () => {
  const base = styleFingerprint(['今天想你了，早点睡', '我在看那本书', '晚安']);
  assert.equal(base.samples, 3);
  assert.ok(base.avgChars > 0);
  const same = styleDrift(base, styleFingerprint(['今天想你了，早点睡', '我在看那本书', '晚安']));
  assert.equal(same.drift, false);
  const drifted = styleDrift(base, styleFingerprint(['哈哈哈哈哈！！！', '真的吗？？', '这也太离谱了吧！！！']));
  assert.equal(drifted.drift, true);
  assert.ok(drifted.worst > 0.25);
});

test('脚本：30/30 通过，退出码 0', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts/living-eval.mjs'), '--json'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout);
  assert.equal(body.total, 30);
  assert.equal(body.passed, 30);
  assert.equal(body.failed, 0);
  assert.equal(body.passRate, 1);
});
