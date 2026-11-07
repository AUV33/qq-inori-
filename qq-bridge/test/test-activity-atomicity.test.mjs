// test-activity-atomicity.test.mjs · 宪章 §5.8：改状态的动作后必须有观察，否则 trace 标盲操作。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-atomic-'));
process.env.QQ_INORI_ROOT = ROOT;
const { createActivityTrackerRegistry, renderTraceHint } = await import('../src/domain/leaves/inori-activity.js');

const TAP = 'mcp__phone__phone_tap';
const LOOK = 'mcp__phone__phone_look';

function run(steps) {
  const reg = createActivityTrackerRegistry();
  for (const [tool, args] of steps) reg.record('k', tool, args, true);
  return reg.finish('k');
}

test('连续操作不观察 → blindActions 计数、observed=false', () => {
  const trace = run([
    [TAP, { x: 1, y: 1 }],
    [TAP, { x: 2, y: 2 }],
    [TAP, { x: 3, y: 3 }],
  ]);
  assert.ok(trace);
  assert.equal(trace.blindActions, 2, '第 2、3 次 tap 之间都没观察');
  assert.equal(trace.observed, false);
});

test('每次操作后都看画面 → blindActions=0、observed=true', () => {
  const trace = run([
    [TAP, { x: 1, y: 1 }],
    [LOOK, {}],
    [TAP, { x: 2, y: 2 }],
    [LOOK, {}],
    [TAP, { x: 3, y: 3 }],
  ]);
  assert.equal(trace.blindActions, 0);
  assert.equal(trace.observed, true);
});

test('提示里会说明盲操作；没有盲操作就不提', () => {
  const blind = run([[TAP, { x: 1, y: 1 }], [TAP, { x: 2, y: 2 }], [TAP, { x: 3, y: 3 }]]);
  const hint = renderTraceHint([blind]);
  assert.match(hint, /没看画面就操作/);
  const observed = run([[TAP, { x: 1, y: 1 }], [LOOK, {}], [TAP, { x: 2, y: 2 }]]);
  assert.equal(/没看画面就操作/.test(renderTraceHint([observed])), false);
});
