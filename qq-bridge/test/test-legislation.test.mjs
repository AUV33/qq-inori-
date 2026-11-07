// test-legislation.test.mjs · L4 立法层：承诺/拒绝/自我信任三本账的宪法判据。
//
// 最关键的一条不是功能，是 C4/A6：
//   只有她能写；系统不自动写 selfTrust；承诺兑现/食言不会自动改信任。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LEGISLATION_VERSION, LEDGER_FILES, LIMITS,
  buildCommitment, buildCommitmentResolution, buildDecline, buildSelfAssessment,
  parseLedgerText, foldCommitments, commitmentFacts, foldDeclined, foldSelfTrust,
  createLegislationStore, LegislationError,
} from '../src/domain/life/legislation.mjs';

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legislation-'));
  const previousTrend = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'learning-trend.jsonl');
  const store = createLegislationStore({ root, now: () => Date.UTC(2026, 10, 5, 12, 0, 0) });
  return { root, store, restore: () => { if (previousTrend === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previousTrend; } };
}

test('make → active；keep → kept；账本折叠状态可读且 id 形状固定', async () => {
  const { store, restore } = tempStore();
  try {
    const row = await store.makeCommitment({ text: '每天睡前回读一次自己的账本', penalty: '把 decoFloor 调回 0.3' }, { writer: 'her' });
    assert.match(row.id, /^cm_\d{8}_[0-9a-f]{6}$/);
    assert.equal(row.kind, 'made');

    let s = await store.state();
    assert.equal(s.commitments.length, 1);
    assert.equal(s.commitments[0].status, 'active');
    assert.deepEqual(s.facts, { total: 1, active: 1, kept: 0, broken: 0 });
    assert.equal(s.selfTrust, null, '承诺本身不产生自我信任');

    await store.resolveCommitment(row.id, 'kept', {}, { writer: 'her' });
    s = await store.state();
    assert.equal(s.commitments[0].status, 'kept');
    assert.ok(s.commitments[0].resolvedAt);
    assert.deepEqual(s.facts, { total: 1, active: 0, kept: 1, broken: 0 });
    assert.equal(s.selfTrust, null, '兑现不自动改 selfTrust（C4/A6）');
  } finally { restore(); }
});

test('食言必须写原因；已了结/未知承诺不能改历史', async () => {
  const { store, restore } = tempStore();
  try {
    const row = await store.makeCommitment({ text: '不熬夜查资料' }, { writer: 'her' });
    await assert.rejects(() => store.resolveCommitment(row.id, 'broken', {}, { writer: 'her' }), /必须写原因/);
    await store.resolveCommitment(row.id, 'broken', { reason: '查资料忘了时间' }, { writer: 'her' });
    await assert.rejects(() => store.resolveCommitment(row.id, 'kept', {}, { writer: 'her' }), /已经了结/);
    await assert.rejects(() => store.resolveCommitment('cm_20261105_abcdef', 'kept', {}, { writer: 'her' }), /没有这条承诺/);
    await assert.rejects(() => store.resolveCommitment(row.id, 'done', {}, { writer: 'her' }), /kept \/ broken/);
  } finally { restore(); }
});

test('C4/A6：三本账只接受 writer=her，系统与 owner 都不能代写', async () => {
  const { store, restore } = tempStore();
  try {
    await assert.rejects(() => store.makeCommitment({ text: 'x' }, { writer: 'owner' }), /只有她能写/);
    await assert.rejects(() => store.makeCommitment({ text: 'x' }, {}), /只有她能写/);
    await assert.rejects(() => store.decline({ target: 'x', reason: 'y' }, { writer: 'system' }), /只有她能写/);
    await assert.rejects(() => store.assessTrust({ value: 0.5, reason: 'x' }, { writer: 'owner' }), /只有她能写/);
    assert.equal(fs.existsSync(store.files.commitments), false, '被拒绝的写入不落盘');
  } finally { restore(); }
});

test('拒绝通道：记录对象+理由，不重试、不惩罚、不降权', async () => {
  const { store, restore } = tempStore();
  try {
    const row = await store.decline({ target: '每日主动提案', reason: '我不想变成打卡机器' }, { writer: 'her' });
    assert.match(row.id, /^dc_\d{8}_[0-9a-f]{6}$/);
    const s = await store.state();
    assert.equal(s.declined.length, 1);
    assert.match(s.declined[0].target, /提案/);
    assert.match(s.declined[0].reason, /打卡/);
    assert.equal(s.facts.total, 0);
  } finally { restore(); }
});

test('selfTrust：只由她的评估改写；最新一次生效；非法值拒绝；与承诺事实独立', async () => {
  const { store, restore } = tempStore();
  try {
    await store.assessTrust({ value: 0.62, reason: '答应自己的事做到了' }, { writer: 'her' });
    let s = await store.state();
    assert.equal(s.selfTrust.value, 0.62);

    await store.assessTrust({ value: 0.41, reason: '两次食言之后' }, { writer: 'her' });
    s = await store.state();
    assert.equal(s.selfTrust.value, 0.41, '最新评估生效');
    assert.match(s.selfTrust.reason, /食言/);

    await assert.rejects(() => store.assessTrust({ value: 1.5, reason: 'x' }, { writer: 'her' }), /0\.\.1/);
    await assert.rejects(() => store.assessTrust({ value: 0.5 }, { writer: 'her' }), /评估理由/);
  } finally { restore(); }
});

test('有界与校验：过长文本/罚则/原因在构造期拒绝，不写半条记录', async () => {
  assert.throws(() => buildCommitment({ text: 'x'.repeat(LIMITS.text + 1) }), /不能超过/);
  assert.throws(() => buildCommitment({ text: 'ok', penalty: 'x'.repeat(LIMITS.penalty + 1) }), /罚则不能超过/);
  assert.throws(() => buildDecline({ target: 'x', reason: '' }), /不能为空/);
  assert.throws(() => buildSelfAssessment({ value: Number.NaN, reason: 'x' }), /0\.\.1/);
  assert.throws(() => buildCommitmentResolution('cm_20261105_abcdef', 'broken', {}), /必须写原因/);
});

test('折叠：未知 id/重复了结不计入状态，进入 anomalies；损坏行进入 corrupt 而非崩溃', async () => {
  const folded = foldCommitments([
    { kind: 'made', id: 'cm_20261105_aaaaaa', ts: 't0', text: 'a', penalty: '' },
    { kind: 'made', id: 'cm_20261105_aaaaaa', ts: 't1', text: 'duplicate', penalty: '' },
    { kind: 'kept', id: 'cm_20261105_bbbbbb', ts: 't2' },
    { kind: 'kept', id: 'cm_20261105_aaaaaa', ts: 't3', reason: '' },
    { kind: 'broken', id: 'cm_20261105_aaaaaa', ts: 't4', reason: 'again' },
  ]);
  assert.equal(folded.commitments.length, 1);
  assert.equal(folded.commitments[0].status, 'kept');
  assert.ok(folded.anomalies.some((x) => x.reason === 'duplicate-or-empty'));
  assert.ok(folded.anomalies.some((x) => x.reason === 'unknown-id'));
  assert.ok(folded.anomalies.some((x) => x.reason === 'already-resolved'));
  assert.deepEqual(commitmentFacts(folded.commitments), { total: 1, active: 0, kept: 1, broken: 0 });
});

test('持久化与损坏容错：重启后状态还在；坏行跳过但可报告', async () => {
  const { root, store, restore } = tempStore();
  try {
    await store.makeCommitment({ text: '读一页自己的账本' }, { writer: 'her' });
    await store.assessTrust({ value: 0.55, reason: '还在学' }, { writer: 'her' });
    fs.appendFileSync(path.join(root, LEDGER_FILES.commitments), 'not-json\n', 'utf8');

    const again = createLegislationStore({ root, now: () => Date.UTC(2026, 10, 6) });
    const s = await again.state();
    assert.equal(s.commitments.length, 1);
    assert.equal(s.selfTrust.value, 0.55);
    assert.equal(s.corrupt.commitments.length, 1);
    assert.equal(s.corrupt.commitments[0].reason, 'bad-json');
  } finally { restore(); }
});

test('纯函数：拒绝记录/自我信任折叠只认合法 kind 与数值', () => {
  assert.deepEqual(foldDeclined([{ kind: 'declined', id: 'dc_1', target: 'a', reason: 'b', ts: 't' }, { kind: 'x' }]).length, 1);
  assert.equal(foldSelfTrust([{ kind: 'assessed', value: 0.3, reason: 'a' }, { kind: 'assessed', value: 9, reason: 'bad' }]).value, 0.3);
  assert.deepEqual(parseLedgerText('{"kind":"made","id":"x"}\nbad\n').corrupt, [{ line: 2, reason: 'bad-json' }]);
});

test('并发追加：同一 store 上并行写 20 条承诺，一条不丢', async () => {
  const { store, restore } = tempStore();
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.makeCommitment({ text: `承诺 ${i}` }, { writer: 'her' })));
    const s = await store.state();
    assert.equal(s.commitments.length, 20);
    assert.equal(new Set(s.commitments.map((x) => x.id)).size, 20);
  } finally { restore(); }
});

test('模块版本与账本文件名是稳定契约', () => {
  assert.equal(LEGISLATION_VERSION, 1);
  assert.deepEqual(Object.keys(LEDGER_FILES).sort(), ['commitments', 'declined', 'selfTrust']);
  assert.equal(LEDGER_FILES.commitments, 'commitments.jsonl');
  assert.equal(LEDGER_FILES.declined, 'declined.jsonl');
  assert.equal(LEDGER_FILES.selfTrust, 'self-trust.jsonl');
  assert.equal(typeof LegislationError, 'function');
});

test('P1-5 崩溃半行：下一次追加先补换行，新记录不丢（半行留作 corrupt 证据）', async () => {
  const { store, restore } = tempStore();
  try {
    await store.makeCommitment({ text: 'first' }, { writer: 'her' });
    fs.appendFileSync(store.files.commitments, '{"v":1,"kind":"made","id":"cm_2026', 'utf8');
    await store.makeCommitment({ text: 'second' }, { writer: 'her' });
    const s = await store.state();
    assert.equal(s.commitments.length, 2, '半行之后的新承诺不能丢');
    assert.equal(s.corrupt.commitments.length, 1, '半行必须作为 corrupt 证据被报告');
  } finally { restore(); }
});

test('P2-11 写失败带 write-failed 码（端点据此回 503，而不是 400）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legislation-fail-'));
  const store = createLegislationStore({ root, append: () => ({ ok: false, error: 'lock timeout' }) });
  const error = await store.makeCommitment({ text: 'x' }, { writer: 'her' }).then(() => null, (e) => e);
  assert.ok(error, '必须抛错');
  assert.equal(error.code, 'write-failed');
});

test('并发了结同一承诺：只有一个成功，另一个明确 already-resolved（不双写）', async () => {
  const { store, restore } = tempStore();
  try {
    const row = await store.makeCommitment({ text: '并发测试' }, { writer: 'her' });
    const results = await Promise.allSettled([
      store.resolveCommitment(row.id, 'kept', {}, { writer: 'her' }),
      store.resolveCommitment(row.id, 'broken', { reason: '想验证并发' }, { writer: 'her' }),
    ]);
    const fulfilled = results.filter((x) => x.status === 'fulfilled');
    const rejected = results.filter((x) => x.status === 'rejected');
    assert.equal(fulfilled.length, 1, '只能有一个成功');
    assert.equal(rejected.length, 1, '另一个必须被明确拒绝');
    assert.match(String(rejected[0].reason?.message ?? ''), /已经了结/);
    const s = await store.state();
    assert.ok(['kept', 'broken'].includes(s.commitments[0].status));
    assert.equal(s.anomalies.length, 0, '串行后账本里不应出现 already-resolved 异常');
  } finally { restore(); }
});
