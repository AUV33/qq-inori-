// 集成：life-loop 把 self-state 的读写委托给 StateHub（单一写入者 / state-hub.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';
import { createLifeLoop } from '../src/domain/life/life-loop.mjs';

test('life-loop 委托 hub：tick 推进状态并原子写 state-hub.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-loop-hub-'));
  let t = 1_000_000;
  const hub = createStateHub({ root: dir, legacyEmotionFile: path.join(dir, 'emotion-vector.json'), now: () => t });
  hub.load();
  const loop = createLifeLoop({
    store: hub.store,
    hub,
    now: () => t,
    lifeLog: { append: () => {} },
    minTickMs: 0,
  });

  t += 60_000; // 清醒 1 分钟
  const r = await loop.tick({ force: true });
  assert.equal(r.skipped, false);
  assert.ok(fs.existsSync(path.join(dir, 'state-hub.json')), '应写出 state-hub.json');
  assert.equal(loop.state, hub.state.self, 'life-loop 应直接持有 Hub 的自状态');
  assert.ok(hub.state.self.energy < 1, '清醒耗能后精力应下降');

  const beforeSleep = hub.state.self.energy;
  t += 3 * 3600_000; // 停摆 3 小时 → 离线休息
  await loop.tick({ force: true });
  assert.ok(hub.state.self.energy >= beforeSleep, `离线休息应恢复精力：${beforeSleep} -> ${hub.state.self.energy}`);
});
