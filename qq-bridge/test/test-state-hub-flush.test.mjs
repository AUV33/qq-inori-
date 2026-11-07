// test-state-hub-flush.test.mjs · S11e 并发：并发 flush 必须串行，慢写不能覆盖新状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateHub } from '../src/domain/mind/state-hub.mjs';

const T = Date.UTC(2026, 10, 5, 12);

test('并发 flush：同一时刻只允许一个写；后一个写的是最新状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-flush-'));
  let inFlight = 0;
  let maxInFlight = 0;
  const writes = [];
  const store = {
    exists: () => false,
    readJson: () => null,
    writeJson: async (file, value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      writes.push({ file, at: value.at, energy: value.self?.energy });
      inFlight -= 1;
      return true;
    },
  };
  let clock = T;
  const hub = createStateHub({ root, store, now: () => clock, log: () => {} });
  hub.load();
  hub.tick({ at: clock, sleeping: false, activity: 'idle' });
  clock = T + 1000;
  hub.tick({ at: clock, sleeping: false, activity: 'idle' });

  const p1 = hub.flush();
  clock = T + 5000;
  hub.tick({ at: clock, sleeping: false, activity: 'idle' });
  const p2 = hub.flush();
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results, [true, true]);
  assert.equal(maxInFlight, 1, '写盘必须串行，不能重叠');
  assert.equal(writes.length, 2);
  assert.equal(writes.at(-1).at, T + 5000, '最后一次写的是最新状态');
});
