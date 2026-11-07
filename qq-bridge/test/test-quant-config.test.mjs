// quant/config 金标：默认关闭、域名白名单、所有数值夹取、非法值退回默认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUANT_DEFAULTS, ALLOWED_DATA_HOSTS, assertDataBaseUrl, resolveQuantConfig, cnyToQuote,
} from '../src/quant/config.js';

test('默认是关闭的（没被主人打开前不跑任何自主下单）', () => {
  assert.equal(QUANT_DEFAULTS.enabled, false);
  assert.equal(resolveQuantConfig().enabled, false);
  assert.equal(resolveQuantConfig({ enabled: 'true' }).enabled, false, '只有严格的 true 才开');
  assert.equal(resolveQuantConfig({ enabled: true }).enabled, true);
});

test('默认值与 100 元本金对齐（100 / 7.1 ≈ 14.08 USDT）', () => {
  const c = resolveQuantConfig();
  assert.equal(c.initialCapitalCny, 100);
  assert.equal(c.cnyPerUsdt, 7.1);
  assert.equal(cnyToQuote(100, c), 14.08450704);
  assert.equal(c.quote, 'USDT');
});

test('行情域名白名单：只允许 https 的 data-api.binance.vision', () => {
  assert.deepEqual(ALLOWED_DATA_HOSTS, ['data-api.binance.vision']);
  assert.equal(assertDataBaseUrl('https://data-api.binance.vision'), 'https://data-api.binance.vision');
  assert.equal(assertDataBaseUrl('https://data-api.binance.vision/api/v3'), 'https://data-api.binance.vision');
  assert.throws(() => assertDataBaseUrl('http://data-api.binance.vision'), /必须是 https/);
  assert.throws(() => assertDataBaseUrl('https://evil.example.com'), /域名不在白名单/);
  assert.throws(() => assertDataBaseUrl('不是URL'), /不是合法 URL/);
});

test('数值全部夹在合法区间；越界取边界，非法值退回默认', () => {
  const low = resolveQuantConfig({ initialCapitalCny: -100, cnyPerUsdt: 0, feeRate: -1, slippageBps: -5, requestTimeoutMs: 1 });
  assert.equal(low.initialCapitalCny, 1);
  assert.equal(low.cnyPerUsdt, 0.01);
  assert.equal(low.feeRate, 0);
  assert.equal(low.slippageBps, 0);
  assert.equal(low.requestTimeoutMs, 1000);

  const high = resolveQuantConfig({ initialCapitalCny: 9e9, cnyPerUsdt: 9999, feeRate: 5, slippageBps: 9999, requestTimeoutMs: 9e9 });
  assert.equal(high.initialCapitalCny, 1_000_000);
  assert.equal(high.cnyPerUsdt, 1000);
  assert.equal(high.feeRate, 0.05);
  assert.equal(high.slippageBps, 500);
  assert.equal(high.requestTimeoutMs, 60_000);

  const junk = resolveQuantConfig({ initialCapitalCny: 'abc', feeRate: null, risk: 'nope' });
  assert.equal(junk.initialCapitalCny, QUANT_DEFAULTS.initialCapitalCny);
  assert.equal(junk.feeRate, QUANT_DEFAULTS.feeRate);
  assert.deepEqual(junk.risk, QUANT_DEFAULTS.risk);
});

test('风控上限也被夹取，且整除成整数', () => {
  const r = resolveQuantConfig({
    risk: { maxPositionPct: 9, maxDailyLossPct: 0, maxTradesPerDay: 3.7, maxOpenPositions: 99 },
  });
  assert.equal(r.risk.maxPositionPct, 1);
  assert.equal(r.risk.maxDailyLossPct, 0.01);
  assert.equal(r.risk.maxTradesPerDay, 4, '向上/就近取整后再夹');
  assert.equal(r.risk.maxOpenPositions, 50);
});

test('quote 统一大写；market 只认 crypto', () => {
  assert.equal(resolveQuantConfig({ quote: 'usdt' }).quote, 'USDT');
  assert.equal(resolveQuantConfig({ market: 'stock' }).market, 'crypto');
});

test('传入 null/非对象也不炸，回到全默认', () => {
  assert.equal(resolveQuantConfig(null).enabled, false);
  assert.equal(resolveQuantConfig('x').quote, 'USDT');
  assert.equal(resolveQuantConfig(undefined).feeRate, 0.001);
});
