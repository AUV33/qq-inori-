// test-life-drive-gate.test.mjs · S4b-4：drive 是门禁判定，不是配置字符串。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateDriveGate, formatDriveGate, DRIVE_REQUIREMENTS,
} from '../src/domain/mind/life-drive-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const okEvidence = {
  requestedMode: 'drive',
  observationHours: 24,
  actReal: true,
  memoryReal: true,
  errors: 0,
  reconcile: { ok: true, reason: 'within-tolerance', drifted: 0 },
};

test('只有全部满足才 allow=drive；缺一项就降级 shadow 并给出 blocker', () => {
  const allowed = evaluateDriveGate(okEvidence);
  assert.equal(allowed.allow, true);
  assert.equal(allowed.effectiveMode, 'drive');
  assert.deepEqual(allowed.blockers, []);

  const noAct = evaluateDriveGate({ ...okEvidence, actReal: false });
  assert.equal(noAct.allow, false);
  assert.equal(noAct.effectiveMode, 'shadow');
  assert.ok(noAct.blockers.includes('act-port-not-real'));

  const noMemory = evaluateDriveGate({ ...okEvidence, memoryReal: false });
  assert.ok(noMemory.blockers.includes('memory-port-not-real'));

  const short = evaluateDriveGate({ ...okEvidence, observationHours: 23 });
  assert.ok(short.blockers.some((b) => b.startsWith('shadow-observation<')));

  const errors = evaluateDriveGate({ ...okEvidence, errors: 2 });
  assert.ok(errors.blockers.includes('unhandled-errors>0'));

  const noData = evaluateDriveGate({ ...okEvidence, reconcile: null });
  assert.ok(noData.blockers.includes('reconcile-no-data'));

  const drift = evaluateDriveGate({ ...okEvidence, reconcile: { ok: false, drifted: 3 } });
  assert.ok(drift.blockers.some((b) => b.startsWith('reconcile-drift:')));
  assert.ok(drift.blockers.includes('reconcile-over-max-drift'));
});

test('非 drive 请求不冒充通过；格式化明确“降级 shadow”', () => {
  const shadow = evaluateDriveGate({ requestedMode: 'shadow' });
  assert.equal(shadow.allow, false);
  assert.equal(shadow.effectiveMode, 'shadow');
  assert.ok(shadow.blockers.includes('not-drive-requested'));
  assert.match(formatDriveGate(evaluateDriveGate({ ...okEvidence, actReal: false })), /drive 门禁：拒绝/);
  assert.match(formatDriveGate(evaluateDriveGate({ ...okEvidence, actReal: false })), /降级 shadow/);
  assert.match(formatDriveGate(evaluateDriveGate(okEvidence)), /通过/);
});

test('需求是稳定契约：24h / 0 drift / act+memory 必须真实 / 零未处理错误', () => {
  assert.equal(DRIVE_REQUIREMENTS.minObservationHours, 24);
  assert.equal(DRIVE_REQUIREMENTS.maxDriftFields, 0);
  assert.equal(DRIVE_REQUIREMENTS.requireActPort, true);
  assert.equal(DRIVE_REQUIREMENTS.requireMemoryPort, true);
  assert.equal(DRIVE_REQUIREMENTS.requireNoErrors, true);
});

test('接线：app 请求 drive 时必须过门禁并降级，日志可审计', () => {
  const app = read('src/app.mjs');
  assert.match(app, /evaluateDriveGate/);
  assert.match(app, /formatDriveGate/);
  assert.match(app, /let lifeMode = requestedLifeMode/);
  assert.match(app, /requestedMode: 'drive'/);
  assert.match(app, /actReal: false/);
  assert.ok(app.includes('log(`[life] ${formatDriveGate(gate)}`)'), '启动日志必须走可审计的格式化');
});
