// 设备资源治理：realtime 永远放行；busy / powersave 时后台让路；flag 文件传感器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceGovernor, createDeviceIdleSensor } from '../src/domain/shared/resource-governor.mjs';

test('governor：realtime 永远放行，busy 时 background 让路', () => {
  let busy = false;
  const g = createResourceGovernor({ isDeviceBusy: () => busy });
  assert.equal(g.canRun('realtime'), true);
  assert.equal(g.canRun('background'), true);
  busy = true;
  assert.equal(g.canRun('realtime'), true);
  assert.equal(g.canRun('background'), false);
});

test('governor：powersave 让路，requestModel 跳过不执行', async () => {
  const g = createResourceGovernor({ isDeviceBusy: () => false });
  g.setMode('powersave');
  assert.equal(g.canRun('background'), false);
  let ran = false;
  const r = await g.requestModel('background', async () => { ran = true; return 1; });
  assert.equal(r.skipped, true);
  assert.equal(ran, false);
  assert.equal(g.status().mode, 'powersave');
});

test('idle sensor：flag 文件 mtime 在窗口内视为忙，过期视为空闲', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
  const flag = path.join(dir, 'device-busy.flag');
  fs.writeFileSync(flag, '');
  const now = Date.now();
  const busySensor = createDeviceIdleSensor({ flagFile: flag, idleWindowMs: 60_000, now: () => now });
  assert.equal(busySensor(), true);
  const idleSensor = createDeviceIdleSensor({ flagFile: flag, idleWindowMs: 60_000, now: () => now + 120_000 });
  assert.equal(idleSensor(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
