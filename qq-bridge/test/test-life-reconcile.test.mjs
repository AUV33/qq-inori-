// test-life-reconcile.test.mjs · 宪章 S4：切主前必须能逐字段看见两套状态的偏差。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareLifeStates, formatReconcileReport, DEFAULT_TOLERANCES } from '../src/domain/mind/life-reconcile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const kernel = {
  energy: 0.70, socialHunger: 0.40, curiosity: 0.50, stress: 0.10, valence: 0.05, mood: 0.10,
  attention: 0.80, selfTrust: 0.50,
  affect: { joy: 0.10, sadness: 0.02, anger: 0, fear: 0, affection: 0.05 },
};
const hub = {
  self: {
    energy: 0.72, socialHunger: 0.38, curiosity: 0.55, stress: 0.12, valence: 0.06, mood: 0.11,
    attention: 0.78, selfTrust: 0.48,
    affect: { joy: 0.11, sadness: 0.03, anger: 0.01, fear: 0, affection: 0.06, curiosity: 0.20 },
  },
};

test('同名字段在容忍带内 → ok；第六维 curiosity 情绪标 missing 而不是硬比', () => {
  const r = compareLifeStates(kernel, hub);
  assert.equal(r.ok, true);
  assert.equal(r.drifted, 0);
  assert.ok(r.checked > 0);
  assert.ok(r.fields.some((f) => f.path === 'affect.curiosity' && f.status === 'missing'));
  assert.ok(r.fields.some((f) => f.path === 'energy' && f.status === 'ok'));
});

test('超容忍 → ok=false，drift 字段可定位；scale 可整体放宽容忍带', () => {
  const far = { self: { ...hub.self, energy: 0.95 } };
  const r = compareLifeStates(kernel, far);
  assert.equal(r.ok, false);
  assert.equal(r.drifted, 1);
  const e = r.fields.find((f) => f.path === 'energy');
  assert.equal(e.status, 'drift');
  assert.ok(e.delta > e.tolerance);
  const loose = compareLifeStates(kernel, far, { scale: 2 });
  assert.equal(loose.ok, true, '观察期可临时放宽 2 倍');
});

test('缺失字段记 missing，不当 drift；no-data 不伪造 0', () => {
  const partial = { self: { energy: 0.7, socialHunger: 0.4, curiosity: 0.5, stress: 0.1, valence: 0.05, mood: 0.1, affect: { joy: 0.1, sadness: 0.02, anger: 0, fear: 0, affection: 0.05 } } };
  const r = compareLifeStates(kernel, partial);
  assert.equal(r.ok, true);
  assert.ok(r.missing >= 2, 'attention/selfTrust 应记 missing');
  assert.equal(r.checked + r.missing, r.fields.length);

  const none = compareLifeStates(null, hub);
  assert.equal(none.reason, 'no-data');
  assert.equal(none.fields.length, 0);
});

test('人读报告：超容忍用 ❌，no-data 给明确提示', () => {
  const far = { self: { ...hub.self, energy: 0.99 } };
  const text = formatReconcileReport(compareLifeStates(kernel, far));
  assert.match(text, /❌ energy/);
  assert.match(text, /禁止切主/);
  assert.match(formatReconcileReport(compareLifeStates(null, null)), /对账无数据/);
});

test('接线：app 有 life.mode；config/example 有 life 段；脚本只读两个 JSON', () => {
  const app = read('src/app.mjs');
  assert.match(app, /lifeMode/);
  assert.match(app, /life\.mode/);
  const config = read('src/bootstrap/config.mjs');
  assert.match(config, /life:\s*\{/);
  const example = JSON.parse(read('config.example.json'));
  // [DE-DUP] 与 test-project-discipline 统一：S4 生命内核新部署默认 shadow（通电/只推演），
  // 旧 config 无 life 段时 bootstrap 兜底 off。两测试此前对默认值期望互斥，统一到 shadow。
  assert.equal(example.life.mode, 'shadow');
  const script = read('scripts/life-reconcile.mjs');
  assert.match(script, /compareLifeStates/);
  assert.match(script, /--check/);
  assert.match(script, /kernelState/);
  assert.match(script, /stateHub/);
});

test('默认容忍带是稳定契约（切主前不允许悄悄放大）', () => {
  assert.deepEqual(Object.keys(DEFAULT_TOLERANCES).sort(), ['affect', 'attention', 'curiosity', 'energy', 'mood', 'selfTrust', 'socialHunger', 'stress', 'valence']);
  assert.equal(DEFAULT_TOLERANCES.energy, 0.15);
  assert.equal(DEFAULT_TOLERANCES.selfTrust, 0.10);
});
