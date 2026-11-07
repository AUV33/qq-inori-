import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cognition from '../src/domain/leaves/inori-cognition.js';

test('认知事务每次在锁内重读，连续更新不会覆盖前一次结果', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-cognition-'));
  const file = path.join(dir, 'cognition.jsonl');
  const trend = path.join(dir, 'trend.jsonl');
  const oldTrend = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = trend;
  try {
    const first = cognition.transact(
      (items) => cognition.add(items, { concept: '甲事实', gist: '第一条认知足够长' }),
      file,
    );
    assert.equal(first.ok, true);

    const second = cognition.transact(
      (items) => cognition.add(items, { concept: '乙事实', gist: '第二条认知足够长' }),
      file,
    );
    assert.equal(second.ok, true);

    const rows = cognition.load(file);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => x.concept), ['甲事实', '乙事实']);
    assert.equal(fs.existsSync(`${file}.lock`), false, '事务结束后应释放锁');
  } finally {
    if (oldTrend == null) delete process.env.LEARNING_TREND;
    else process.env.LEARNING_TREND = oldTrend;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
