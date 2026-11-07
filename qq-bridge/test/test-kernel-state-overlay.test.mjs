// test-kernel-state-overlay.test.mjs · S4b-2：双写标量的"读"先收敛到 state-hub。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { overlayDualFields, overlayReport } from '../src/domain/mind/kernel-state-overlay.mjs';
import { DUAL_FIELDS } from '../src/domain/mind/life-authority.mjs';
import { createShadowPorts } from '../src/kernel/ports.mjs';
import { createKernel } from '../src/kernel/index.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const own = {
  at: T - 60000, energy: 0.4, sleepDebt: 0.2, socialHunger: 0.3, curiosity: 0.4,
  stress: 0.2, valence: 0.1, mood: 0.1, attention: 0.7, selfTrust: 0.6,
  goals: [{ id: 'g1' }], affect: { joy: 0.1 },
};
const hub = {
  at: T,
  self: { energy: 0.9, sleepDebt: 0.1, socialHunger: 0.5, curiosity: 0.6, stress: 0.05, valence: 0.3, mood: 0.2 },
};

test('双写字段全部以 hub 为准；kernel 独占字段保留；时间戳取 hub.at', () => {
  const merged = overlayDualFields(own, hub);
  for (const field of DUAL_FIELDS) assert.equal(merged[field], hub.self[field], field);
  assert.equal(merged.attention, 0.7);
  assert.equal(merged.selfTrust, 0.6);
  assert.deepEqual(merged.goals, [{ id: 'g1' }]);
  assert.equal(merged.at, T);
  assert.equal(merged.dualSource, 'state-hub');
  assert.equal(overlayReport(own, hub).source, 'state-hub');
});

test('缺 hub / 缺 self / 非有限值：不伪造，原样或跳过', () => {
  assert.equal(overlayDualFields(own, null), own);
  const atOnly = overlayDualFields(own, { at: T });
  assert.equal(atOnly.at, T);
  assert.equal(atOnly.energy, own.energy, '没有 self 字段时不得改标量');
  assert.equal(overlayDualFields(null, hub), null);
  const partial = overlayDualFields(own, { at: T, self: { energy: 'bad', stress: 0.4 } });
  assert.equal(partial.energy, 0.4, '坏值跳过');
  assert.equal(partial.stress, 0.4);
  assert.equal(overlayReport(own, null).source, 'kernel');
});

test('内核 tick 读到的是 hub 值（dt=0，不再双倍推进时间）', () => {
  const written = [];
  const store = { readJson: () => own, writeJson: (f, v) => { written.push(v); return v; } };
  const ports = createShadowPorts({ at: T, store });
  const baseLoad = ports.state.load.bind(ports.state);
  ports.state.load = () => overlayDualFields(baseLoad(), hub);
  const k = createKernel({ ports, reflectMs: 1000 * 60 * 60 });
  k.tick(T);
  // 读到 hub 的 0.9 后，本 tick 的动作可能再扣一点（action.taken），但不得出现时间双倍衰减。
  assert.ok(k.state.energy <= 0.9 && k.state.energy >= 0.85, String(k.state.energy));
  assert.equal(k.state.selfTrust, 0.6);
  assert.equal(k.state.at, T);
  assert.ok(written.length >= 1);
});

test('接线：app 通过 runtime ports 装配 overlay（读写收敛的单一入口）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.mjs'), 'utf8');
  assert.match(app, /createKernelRuntimePorts/);
  assert.match(app, /读=state-hub/);
  assert.match(app, /写回=applyKernelProjection/);
});
