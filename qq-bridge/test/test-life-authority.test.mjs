// test-life-authority.test.mjs · S4b：先承认双写，再谈收敛。矩阵是契约，不是愿望。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_OWNERS, DUAL_FIELDS, AUTHORITY_PENDING, checkWrite, authorityReport,
} from '../src/domain/mind/life-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('单写字段：kernel 与 state-hub 各归其位', () => {
  assert.equal(FIELD_OWNERS.selfTrust, 'kernel');
  assert.equal(FIELD_OWNERS.goals, 'kernel');
  assert.equal(FIELD_OWNERS.affect, 'state-hub');
  assert.equal(FIELD_OWNERS.beliefs, 'state-hub');
  assert.equal(checkWrite('kernel', 'selfTrust').ok, true);
  assert.equal(checkWrite('kernel', 'affect').ok, false);
  assert.equal(checkWrite('kernel', 'affect').reason, 'foreign-owner');
  assert.equal(checkWrite('state-hub', 'affect').ok, true);
});

test('双写字段：身份明确是"待收敛"，不是允许双写', () => {
  for (const field of DUAL_FIELDS) {
    const r = checkWrite('kernel', field);
    assert.equal(r.ok, true);
    assert.equal(r.dual, true);
    assert.equal(r.reason, 'dual-pending-convergence');
  }
  assert.ok(DUAL_FIELDS.includes('valence') && DUAL_FIELDS.includes('energy'));
});

test('未知字段交上层，不误杀；报告是稳定契约', () => {
  assert.equal(checkWrite('anything', 'nope').reason, 'not-covered');
  const report = authorityReport();
  assert.equal(report.dualCount, DUAL_FIELDS.length);
  assert.equal(report.pending.length, AUTHORITY_PENDING.length);
  assert.ok(report.pending.some((x) => /affect/.test(x)));
  assert.ok(report.singleWriterFields > 0);
});

test('接线：app 启动会输出 authority 报告（不假装已收敛）', () => {
  const app = read('src/app.mjs');
  assert.match(app, /authorityReport/);
  assert.match(app, /\[authority\] 单写字段/);
  assert.match(app, /双写待收敛/);
});
