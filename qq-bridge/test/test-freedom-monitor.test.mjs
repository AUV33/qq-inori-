import test from 'node:test';
import assert from 'node:assert/strict';
import { toFreedomRow, summarizeFreedom, checkFreedomMonitor, formatFreedomSummary } from '../src/domain/social/freedom-monitor.js';

const now = 1_800_000_000_000;
const row = toFreedomRow({ key: 'group:1', mode: 'reserved2', trust: 'group', reply: { can: true, options: ['reply', 'wait', 'silence'] }, initiate: { can: false, remaining: 0 }, explore: { can: false, budgetLeft: 0 }, selfEdit: { can: false }, manageGroup: { can: false } }, now);

test('toFreedomRow 只保留观测字段', () => {
  assert.equal(row.key, 'group:1');
  assert.equal(row.reply, true);
  assert.deepEqual(row.replyOptions, ['reply', 'wait', 'silence']);
  assert.equal(row.selfEdit, false);
  assert.equal(row.at, new Date(now).toISOString());
});

test('summary 计数', () => {
  const s = summarizeFreedom([row, { ...row, trust: 'owner', selfEdit: true, manageGroup: true }]);
  assert.equal(s.total, 2);
  assert.equal(s.byTrust.group, 1);
  assert.equal(s.byTrust.owner, 1);
  assert.equal(s.selfEdit, 1);
  assert.equal(s.manageGroup, 1);
});

test('monitor 健康：空/缺字段/过期/正常', () => {
  assert.equal(checkFreedomMonitor([], { now }).reason, 'no-records');
  assert.equal(checkFreedomMonitor([{ at: row.at }], { now }).reason, 'schema-incomplete');
  assert.equal(checkFreedomMonitor([{ ...row, at: new Date(now - 25 * 3600 * 1000).toISOString() }], { now }).reason, 'stale');
  assert.equal(checkFreedomMonitor([row], { now }).ok, true);
});

test('report 行固定字段', () => {
  const line = formatFreedomSummary(summarizeFreedom([row]), checkFreedomMonitor([row], { now }));
  assert.match(line, /^\[freedom-report\] total=1/);
  assert.match(line, /health=ok/);
});
