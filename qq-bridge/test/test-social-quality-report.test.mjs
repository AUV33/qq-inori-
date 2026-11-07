import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeQuality } from '../scripts/social-quality-report.mjs';

const T = 1793772000000;
const iso = (ms) => new Date(ms).toISOString();

test('summarizeQuality：漏接/被接住/策略串起来；无样本 unknown', () => {
  const floor = [{ key: 'group:1', at: iso(T), directed: true, wake: true }];
  const action = [{ t: 'turn', key: 'group:1', outcome: 'sent', ts: iso(T + 5000) }];
  const events = [
    { type: 'message.sent', key: 'group:1', at: T + 10000 },
    { type: 'message.received', key: 'group:1', at: T + 20000 },
  ];
  const r = summarizeQuality({ floor, action, events });
  assert.equal(r.missed.directedWakes, 1);
  assert.equal(r.missed.missed, 0);
  assert.equal(r.caught.sends, 1);
  assert.equal(r.caught.caught, 1);
  assert.ok(['normal', 'watch', 'caution', 'unknown'].includes(r.policy.level));
  const empty = summarizeQuality({});
  assert.equal(empty.policy.level, 'unknown');
});
