// test-kernel-runtime-ports.test.mjs · S4b-3：读收敛 + 写回收敛（hub 是双写字段的文件写者）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKernelRuntimePorts } from '../src/domain/mind/kernel-runtime-ports.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';
import { createKernel } from '../src/kernel/index.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const H = 3600000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeStore(state = null) {
  const written = [];
  return {
    written,
    readJson: () => state,
    writeJson: (file, value) => { written.push({ file, value }); return value; },
  };
}

test('读收敛 + 写回：kernel tick 后的双写标量回写 hub；kernel 独有字段不写', () => {
  const store = fakeStore({ at: T, energy: 0.4, selfTrust: 0.6, attention: 0.7, goals: [] });
  const projections = [];
  const hub = {
    at: T,
    snapshot: () => ({ at: T, self: { energy: 0.9, socialHunger: 0.2, stress: 0.05, valence: 0.2, mood: 0.1, sleepDebt: 0.1, curiosity: 0.3 } }),
    applyKernelProjection: (projection, opts) => { projections.push({ projection, opts }); return true; },
    maybeFlush: () => true,
  };
  const ports = createKernelRuntimePorts({ at: T, store, hub });
  const k = createKernel({ ports, reflectMs: 1000 * H });
  k.tick(T);
  assert.equal(projections.length, 1, 'tick 后必须回写一次');
  const { projection, opts } = projections[0];
  assert.equal(projection.energy, k.state.energy);
  assert.equal(projection.socialHunger, k.state.socialHunger);
  assert.equal(opts.at, k.state.at);
  assert.equal('selfTrust' in projection, false, 'kernel 独有字段不写 hub');
  assert.ok(store.written.some((x) => x.file === 'kernel-state.json'));
});

test('无 hub 时退化为纯影子，不抛错；非有限值不写', () => {
  const store = fakeStore({ at: T, energy: 0.5 });
  const ports = createKernelRuntimePorts({ at: T, store, hub: null });
  const k = createKernel({ ports, reflectMs: 1000 * H });
  assert.doesNotThrow(() => k.tick(T));
  const hub = { snapshot: () => ({ at: T, self: { energy: 'bad' } }), applyKernelProjection: () => false };
  const ports2 = createKernelRuntimePorts({ at: T, store, hub });
  const k2 = createKernel({ ports: ports2, reflectMs: 1000 * H });
  k2.tick(T); // 不应因坏值抛错
});

test('state-hub 接收投影：7 字段、clamp、at 单调、旧投影不覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-writeback-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const hub = createStateHub({ root, now: () => T, log: () => {} });
    hub.load();
    const changed = hub.applyKernelProjection({ energy: 0.42, mood: 2, socialHunger: 0.33, selfTrust: 0.1 }, { at: T + 1000 });
    assert.equal(changed, true);
    assert.equal(hub.state.self.energy, 0.42);
    assert.equal(hub.state.self.mood, 1, 'clamp 到 1');
    assert.equal(hub.state.self.socialHunger, 0.33);
    assert.equal('selfTrust' in hub.state.self, false, '非双写字段不接收');
    assert.equal(hub.state.at, T + 1000);

    // [AUDIT-FIX] 字段没变也必须推进 at，否则 kernel 会从旧 at 再衰减一次（双倍时间）。
    const sameFields = hub.applyKernelProjection({ energy: 0.42 }, { at: T + 2000 });
    assert.equal(sameFields, false, '字段没变返回 false');
    assert.equal(hub.state.at, T + 2000, 'at 必须推进，防止双倍时间衰减');

    const stale = hub.applyKernelProjection({ energy: 0.1 }, { at: T });
    assert.equal(stale, false, '旧投影不得回退状态');
    assert.equal(hub.state.self.energy, 0.42);
    assert.equal(await hub.flush(), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'state-hub.json'), 'utf8'));
    assert.equal(saved.self.energy, 0.42);
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});

test('接线：app 用 runtime ports；入站消息镜像到 sense；日志说明读写收敛', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.mjs'), 'utf8');
  assert.match(app, /createKernelRuntimePorts/);
  assert.match(app, /lifeSenseHolder\.current = shadowPorts\.sense/);
  assert.match(app, /lifeSenseHolder\.current\.push\(\{ type: 'message\.received'/);
  assert.match(app, /读=state-hub/);
  assert.match(app, /写回=applyKernelProjection/);
});
