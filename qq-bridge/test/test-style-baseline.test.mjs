// test-style-baseline.test.mjs · S10f：她自己的文风基线、漂移、≤5% 步长。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectUtterances, buildStyleBaseline, planStyleStep, MIN_SAMPLES,
} from '../scripts/lib/style-baseline.mjs';
import { styleFingerprint } from '../scripts/lib/living-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/style-baseline.mjs');
const T = Date.now();

test('收集：只收 utterance、有时间窗；基线样本不足标记', () => {
  const rows = [
    { kind: 'utterance', text: '今天想你了', time: T - 1000 },
    { kind: 'utterance', text: '晚安', time: T - 2000 },
    { kind: 'event', text: '不是她说的', time: T - 3000 },
    { kind: 'utterance', text: '太旧了', time: T - 100 * 86400000 },
    { kind: 'utterance', text: '' },
  ];
  assert.deepEqual(collectUtterances(rows, { now: T, days: 90 }), ['今天想你了', '晚安']);
  const few = buildStyleBaseline(['短句'], { now: T });
  assert.equal(few.insufficient, true);
  const enough = buildStyleBaseline(Array.from({ length: MIN_SAMPLES }, (_, i) => `今天第 ${i} 条消息`), { now: T });
  assert.equal(enough.insufficient, false);
  assert.equal(enough.metrics.samples, MIN_SAMPLES);
});

test('步长：每个指标相对移动 ≤5%，不会一步跳到目标', () => {
  const base = { metrics: { avgChars: 20, emojiRate: 0.1, questionRate: 0.2, exclaimRate: 0, firstPersonRate: 0.1, cjkRate: 1 } };
  const cur = { metrics: { avgChars: 40, emojiRate: 0.1, questionRate: 0.2, exclaimRate: 0.8, firstPersonRate: 0.1, cjkRate: 1 } };
  const plan = planStyleStep(base, cur, { maxStep: 0.05 });
  assert.equal(plan.steps.avgChars.step, 0.05);
  assert.ok(plan.steps.avgChars.to > 20 && plan.steps.avgChars.to < 40);
  assert.equal(plan.steps.exclaimRate.step, 0.05);
  assert.ok(Math.abs(plan.steps.exclaimRate.to - 0.05) < 1e-9, '零基线用 5% 绝对值起步');
});

function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_INORI_ROOT: root },
  });
}
function setup(n = 12) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-baseline-'));
  const mem = path.join(root, 'data', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => ({ kind: 'utterance', text: `今天第 ${i} 条消息，挺好`, time: T - i * 1000 }));
  fs.writeFileSync(path.join(mem, 'memory.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { root, file: path.join(root, 'data', 'state', 'mind', 'style-baseline.json') };
}

test('CLI：dry-run 不写；--apply 写基线；compare/plan 可用且步长 ≤5%', () => {
  const { root, file } = setup();
  let out = run(root, ['--save']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, false);
  assert.equal(fs.existsSync(file), false);

  out = run(root, ['--save', '--apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, true);
  assert.ok(fs.existsSync(file));

  out = run(root, ['--compare']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).drift.drift, false);

  out = run(root, ['--compare', '--days=0.00001']);
  assert.equal(out.status, 1, '当前样本不足时不得比较漂移');
  assert.match(JSON.parse(out.stdout).reason, /样本不足/);

  out = run(root, ['--plan']);
  assert.equal(out.status, 0, out.stderr);
  const plan = JSON.parse(out.stdout);
  assert.equal(plan.maxStep, 0.05);
  for (const row of Object.values(plan.steps)) assert.ok(Math.abs(row.step) <= 0.05 + 1e-9);
  assert.deepEqual(styleFingerprint(['今天第 1 条消息，挺好']).samples, 1);
});

test('空数据：save 拒绝（样本不足），compare/plan 拒绝（无基线）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-empty-'));
  const mem = path.join(root, 'data', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'memory.jsonl'), '', 'utf8');
  let out = run(root, ['--save', '--apply']);
  assert.equal(out.status, 1);
  out = run(root, ['--compare']);
  assert.equal(out.status, 1);
  out = run(root, ['--plan']);
  assert.equal(out.status, 1);
});
