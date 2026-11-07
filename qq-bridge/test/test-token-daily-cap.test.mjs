import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenLedger } from '../src/domain/memory/token-ledger.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-daily-'));
const file = path.join(tmpDir, 'token-usage.jsonl');

function freshLedger() {
  try { fs.unlinkSync(file); } catch { /* 首次没有 */ }
  return createTokenLedger({ file });
}

const at = (iso) => Date.parse(iso);
const ev = (seq, turn, time, tokens = 1_000_000) => ({
  seq,
  time,
  type: 'assistant/message',
  data: { turn, step: 1, usage: { inputTokens: tokens, outputTokens: 1000, cacheReadTokens: 0 } },
});

test('todayTotals：只算本地自然日内的采样，昨天的不算', () => {
  const ledger = freshLedger();
  ledger.ingestEvent({ sessionId: 's1', event: ev(1, 1, at('2026-10-29T10:00:00+08:00')) });
  ledger.ingestEvent({ sessionId: 's1', event: ev(2, 2, at('2026-10-29T23:30:00+08:00')) });
  ledger.ingestEvent({ sessionId: 's1', event: ev(3, 3, at('2026-10-28T23:59:00+08:00')) });
  const t = ledger.todayTotals({ at: at('2026-10-29T23:59:00+08:00') });
  assert.equal(t.tokens, 2 * 1_001_000);
  assert.equal(t.turns, 2);
  assert.ok(t.cost > 0, '当天花费应大于 0');
  assert.equal(t.from, at('2026-10-29T00:00:00+08:00'), '起点是本地 0 点');
});

test('todayTotals：0 点整那一条算新的一天', () => {
  const ledger = freshLedger();
  ledger.ingestEvent({ sessionId: 's1', event: ev(1, 1, at('2026-10-29T00:00:00+08:00')) });
  const t = ledger.todayTotals({ at: at('2026-10-29T12:00:00+08:00') });
  assert.equal(t.tokens, 1_001_000);
});

test('todayTotals：at 之后的采样不算（截止时间生效）', () => {
  const ledger = freshLedger();
  ledger.ingestEvent({ sessionId: 's1', event: ev(1, 1, at('2026-10-29T22:00:00+08:00')) });
  const t = ledger.todayTotals({ at: at('2026-10-29T21:00:00+08:00') });
  assert.equal(t.tokens, 0);
  assert.equal(t.cost, 0);
  assert.equal(t.turns, 0);
});

test('todayTotals：空账本返回零值（不抛）', () => {
  const ledger = freshLedger();
  const t = ledger.todayTotals({ at: at('2026-10-29T12:00:00+08:00') });
  assert.equal(t.tokens, 0);
  assert.equal(t.cost, 0);
  assert.equal(t.turns, 0);
  assert.equal(t.from, at('2026-10-29T00:00:00+08:00'));
});
