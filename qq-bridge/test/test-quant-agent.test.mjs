// test/test-quant-agent.test.mjs · 量化工具层（离线）
//
// 账户/日记都写在 .tmp 下（沙箱只允许仓库根的 .tmp 可写），不碰真实 state。
// 下单用注入的 price，不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '..', '..', '.tmp', `quant-agent-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

process.env.QQ_INORI_QUANT_DIR = TMP;
process.env.QQ_INORI_QUANT_JSON = JSON.stringify({
  enabled: true,
  initialCapitalCny: 100,
  cnyPerUsdt: 7.1,
  feeRate: 0.001,
  slippageBps: 5,
  minNotionalUsdt: 5,
  risk: { maxPositionPct: 0.5, maxDailyLossPct: 0.1, maxTradesPerDay: 10, maxOpenPositions: 2 },
});

const agent = await import('../src/quant/agent.js');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test.beforeEach(() => {
  agent._resetCooldownForTest();
  try { fs.rmSync(path.join(TMP, 'account.json'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TMP, 'journal.jsonl'), { force: true }); } catch { /* ignore */ }
});

test('agent: status 建出 100 元的模拟账户', () => {
  const r = agent.quantStatus();
  assert.equal(r.ok, true);
  assert.match(r.text, /14\.08/);
  assert.match(r.text, /100 元/);
  assert.match(r.text, /模拟盘/);
  assert.equal(r.account.equity, 14.08450704);
});

test('agent: 记想法写进日记并能读回', () => {
  const w = agent.quantNote({ text: '现在这行情我不想动', tags: ['观望'] });
  assert.equal(w.ok, true);
  const j = agent.quantJournal({ limit: 5 });
  assert.match(j.text, /观望/);
  assert.match(j.text, /不想动/);
  assert.equal(j.rows.length, 1);
});

test('agent: 空想法被拒', () => {
  assert.equal(agent.quantNote({ text: '   ' }).ok, false);
});

test('agent: 买入成功、30 秒内再买被冷却拒', async () => {
  const a = await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 });
  assert.equal(a.ok, true, a.reason);
  assert.ok(a.fill.qty > 0);
  const b = await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 });
  assert.equal(b.ok, false);
  assert.match(b.reason, /再等/);
});

test('agent: 冷却过后仍受单仓 50% 风控约束', async () => {
  assert.equal((await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 })).ok, true);
  agent._resetCooldownForTest();
  const b = await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 });
  assert.equal(b.ok, false);
  assert.match(b.reason, /单仓/);
});

test('agent: 卖出 all 清仓，日记记两笔', async () => {
  assert.equal((await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 })).ok, true);
  agent._resetCooldownForTest();
  const s = await agent.quantSell({ symbol: 'BTCUSDT', qty: 'all', price: 110 });
  assert.equal(s.ok, true, s.reason);
  assert.ok(s.fill.realizedPnl > 0);
  const j = agent.quantJournal({ limit: 10 });
  assert.equal(j.rows.length, 2);
  assert.match(j.text, /买|卖/);
});

test('agent: 没持仓时卖被拒且不写日记', async () => {
  const s = await agent.quantSell({ symbol: 'BTCUSDT', qty: 'all', price: 100 });
  assert.equal(s.ok, false);
  assert.equal(agent.quantJournal({ limit: 5 }).rows.length, 0);
});

test('agent: enabled=false 时写操作全拒', async () => {
  const saved = process.env.QQ_INORI_QUANT_JSON;
  process.env.QQ_INORI_QUANT_JSON = JSON.stringify({ enabled: false });
  try {
    assert.equal(agent.quantNote({ text: 'x' }).ok, false);
    const b = await agent.quantBuy({ symbol: 'BTCUSDT', notional: 6, price: 100 });
    assert.equal(b.ok, false);
    assert.match(b.reason, /没开/);
    assert.equal(agent.quantSnapshotLine(), null);
  } finally {
    process.env.QQ_INORI_QUANT_JSON = saved;
  }
});

test('agent: snapshot 行带净值与两个工具名', () => {
  const line = agent.quantSnapshotLine();
  assert.ok(line);
  assert.match(line, /量化/);
  assert.match(line, /14\.08/);
  assert.match(line, /qq_quant_status/);
  assert.match(line, /qq_quant_note/);
});
