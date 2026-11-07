// test-bonds.test.mjs · 宪章 §5.9/G5：关系要能说清"为什么变"，且误读可回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BOND_BASELINE, BOND_DIMENSIONS, buildObservation, buildTaboo, buildRevoke,
  foldBonds, bondFor, parseBondsLedger, bondsSummary, createBondsStore, BondsError,
} from '../src/domain/social/bonds.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const PID = 'p_2e3e29ecdbe6';
const obs = (over = {}) => buildObservation({ personId: PID, dimension: 'trust', delta: 0.2, evidenceId: 'ev1', at: T, ...over });

test('构造校验：personId/dimension/delta/evidence 缺一不可', () => {
  assert.equal(obs().delta, 0.2);
  assert.throws(() => buildObservation({ personId: 'bad', dimension: 'trust', delta: 0.1, evidenceId: 'e' }), /personId/);
  assert.throws(() => buildObservation({ personId: PID, dimension: 'love', delta: 0.1, evidenceId: 'e' }), /dimension/);
  assert.throws(() => buildObservation({ personId: PID, dimension: 'trust', delta: 0.9, evidenceId: 'e' }), /delta/);
  assert.throws(() => buildObservation({ personId: PID, dimension: 'trust', delta: 0.1 }), /evidenceId/);
  assert.throws(() => buildTaboo({ personId: PID, topic: '', evidenceId: 'e' }), /topic/);
  assert.throws(() => buildRevoke({ evidenceId: '' }), /evidenceId/);
});

test('折叠：基线 0.5，正负增量 clamp；同 evidenceId 只生效一次', () => {
  let folded = foldBonds([obs()]);
  assert.equal(bondFor(folded, PID).trust, 0.7);
  assert.equal(bondFor(folded, PID).affinity, BOND_BASELINE);

  folded = foldBonds([obs({ dimension: 'affinity', delta: -0.3, evidenceId: 'ev2' }), obs({ dimension: 'trust', delta: 0.2, evidenceId: 'ev1' })]);
  assert.equal(bondFor(folded, PID).affinity, 0.2);
  assert.equal(bondFor(folded, PID).trust, 0.7);

  const dup = foldBonds([obs({ evidenceId: 'same' }), obs({ evidenceId: 'same', delta: 0.4 })]);
  assert.equal(bondFor(dup, PID).trust, 0.7, '同一证据不得重复加分');
  assert.ok(dup.anomalies.some((a) => a.reason === 'duplicate-evidence'));

  folded = foldBonds([obs({ delta: 0.5, evidenceId: 'a' }), obs({ delta: 0.5, evidenceId: 'b' })]);
  assert.equal(bondFor(folded, PID).trust, 1, '上限 1');
  assert.equal(BOND_DIMENSIONS.length, 3);
});

test('历史超长 evidenceId 的 revoke 也能匹配（落盘口径截断）', () => {
  const longId = 'z'.repeat(140);
  const folded = foldBonds([
    { kind: 'observe', personId: PID, dimension: 'trust', delta: 0.4, evidenceId: longId, at: T },
    { kind: 'revoke', evidenceId: longId, at: T + 1 },
  ]);
  assert.equal(bondFor(folded, PID), null, '长 revoke 必须匹配截断后的 observe');
});

test('长 evidenceId 也能撤销；坏 delta 不烧证据；同证据可影响不同维度', () => {
  const longId = 'e'.repeat(5) + 'x'.repeat(130);
  const longRevoke = foldBonds([obs({ evidenceId: longId, delta: 0.4 }), buildRevoke({ evidenceId: longId, at: T + 1 })]);
  assert.equal(bondFor(longRevoke, PID), null, '长证据撤销后不应留下人物记录');

  const healed = foldBonds([
    { kind: 'observe', personId: PID, dimension: 'trust', delta: 'NaN', evidenceId: 'msg:2', at: T },
    obs({ personId: PID, dimension: 'trust', delta: 0.3, evidenceId: 'msg:2', at: T + 1 }),
  ]);
  assert.equal(bondFor(healed, PID).trust, 0.8, '坏 delta 不应占用 evidenceId');
  assert.ok(healed.anomalies.some((a) => a.reason === 'bad-delta'));

  const both = foldBonds([
    obs({ personId: PID, dimension: 'trust', delta: 0.3, evidenceId: 'msg:1' }),
    obs({ personId: PID, dimension: 'affinity', delta: 0.3, evidenceId: 'msg:1' }),
  ]);
  assert.equal(bondFor(both, PID).trust, 0.8);
  assert.equal(bondFor(both, PID).affinity, 0.8, '同一条证据可以同时影响两个维度');
});

test('可逆：revoke 后重算，不留下"永久芥蒂"', () => {
  // 先有一条真实证据，再有一条误读 + 撤销：误读不留下永久影响。
  const events = [
    obs({ dimension: 'trust', delta: 0.2, evidenceId: 'real', at: T }),
    obs({ dimension: 'affinity', delta: -0.4, evidenceId: 'misread', at: T }),
    buildRevoke({ evidenceId: 'misread', reason: '后来发现他不是回避', at: T + 1 }),
  ];
  const folded = foldBonds(events);
  assert.equal(bondFor(folded, PID).trust, 0.7);
  assert.equal(bondFor(folded, PID).affinity, BOND_BASELINE);
  assert.deepEqual(bondFor(folded, PID).evidenceIds, ['real']);

  const taboo = foldBonds([buildTaboo({ personId: PID, topic: '体重', evidenceId: 't1', at: T }), buildRevoke({ evidenceId: 't1', at: T + 1 })]);
  assert.equal(bondFor(taboo, PID)?.taboo.length ?? 0, 0);
});

test('禁忌：记录 topic，不重复；坏事件进 anomalies', () => {
  const folded = foldBonds([
    buildTaboo({ personId: PID, topic: '体重', evidenceId: 't1', at: T }),
    buildTaboo({ personId: PID, topic: '体重', evidenceId: 't2', at: T }),
  ]);
  const bond = bondFor(folded, PID);
  assert.equal(bond.taboo.length, 1);
  assert.equal(bondFor(folded, 'p_aaaaaaaaaaaa'), null);

  const bad = foldBonds([
    { kind: 'observe', personId: 'bad', dimension: 'trust', delta: 0.1, evidenceId: 'x' },
    { kind: 'observe', personId: PID, dimension: 'nope', delta: 0.1, evidenceId: 'y' },
    { kind: 'observe', personId: PID, dimension: 'trust', delta: 0.1 },
    { kind: 'nonsense', personId: PID },
  ]);
  assert.ok(bad.anomalies.some((a) => a.reason === 'bad-person'));
  assert.ok(bad.anomalies.some((a) => a.reason === 'bad-dimension'));
  assert.ok(bad.anomalies.some((a) => a.reason === 'missing-evidence'));
  assert.ok(bad.anomalies.some((a) => String(a.reason).startsWith('unknown-kind')));
});

test('存储：append 白名单、读回折叠、坏行 corrupt、摘要', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonds-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const file = path.join(root, 'bonds.jsonl');
    const store = createBondsStore({ file, now: () => T });
    await store.observe({ personId: PID, dimension: 'trust', delta: 0.2, evidenceId: 'ev1' });
    await store.taboo({ personId: PID, topic: '体重', evidenceId: 't1' });
    await assert.rejects(() => store.appendEvent(buildRevoke({ evidenceId: 'ev1', at: T }), { writer: 'nope' }), /白名单/);
    fs.appendFileSync(file, 'bad-json\n', 'utf8');
    const s = await store.state();
    assert.equal(s.people.length, 1);
    assert.equal(s.corrupt.length, 1);
    assert.deepEqual(bondsSummary(s), { people: 1, taboos: 1, evidence: 1, anomalies: 0 });
    assert.deepEqual(parseBondsLedger('{"kind":"observe"}\nbad\n').corrupt, [{ line: 2, reason: 'bad-json' }]);
    assert.equal(typeof BondsError, 'function');
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});

test('消费端：state-hub 读得到关系与禁忌，键是 personId（无 PII）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonds-view-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const store = createBondsStore({ file: path.join(root, 'bonds.jsonl'), now: () => T });
    await store.observe({ personId: PID, dimension: 'affinity', delta: 0.2, evidenceId: 'e1' });
    await store.taboo({ personId: PID, topic: '体重', evidenceId: 't1' });
    const hub = createStateHub({ root, now: () => T, log: () => {} });
    hub.load();
    assert.equal(hub.status().bonds.people, 1);
    assert.equal(hub.getBonds().summary.taboos, 1);
    assert.equal(hub.getBond(PID).affinity, 0.7);
    assert.equal(hub.getBond('p_ffffffffffff'), null);
    const raw = fs.readFileSync(path.join(root, 'bonds.jsonl'), 'utf8');
    assert.equal(/QQ|10001|示例甲/.test(raw), false, '关系账不落 PII 明文');
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});
