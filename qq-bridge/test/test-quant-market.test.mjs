// quant/market 金标：只读行情——参数校验、K 线解析、网络失败回退缓存（stale）、ticker 与交易规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSymbol, assertInterval, fetchJson, parseKlines, readCachedKlines, getKlines, getTicker, getSymbolRules,
} from '../src/quant/market.js';

const NOW = 1_800_000_000_000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-market-'));
const res = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const kline = (i, close) => [NOW + i * 60000, '1', '2', '0.5', String(close), '10', NOW + i * 60000 + 59999];

test('assertSymbol / assertInterval：白名单校验', () => {
  assert.equal(assertSymbol('btcusdt'), 'BTCUSDT');
  assert.throws(() => assertSymbol('BTC'), /非法交易对/);
  assert.throws(() => assertSymbol('BTC/USDT'), /非法交易对/);
  assert.equal(assertInterval('1h'), '1h');
  assert.throws(() => assertInterval('2d'), /非法 K 线周期/);
});

test('fetchJson：非 2xx 抛错；正常返回 JSON；超时也会抛', async () => {
  assert.deepEqual(await fetchJson('http://x', { fetchImpl: async () => res({ a: 1 }) }), { a: 1 });
  await assert.rejects(() => fetchJson('http://x', { fetchImpl: async () => res({}, false, 500) }), /HTTP 500/);
});

test('parseKlines：归一化字段并过滤无效收盘价', () => {
  const bars = parseKlines([kline(0, 10), kline(1, '0'), kline(2, 12)]);
  assert.equal(bars.length, 2, '收盘价 0 的被过滤');
  assert.deepEqual(Object.keys(bars[0]).sort(), ['close', 'closeTime', 'high', 'low', 'open', 'openTime', 'volume']);
  assert.equal(bars[0].close, 10);
  assert.throws(() => parseKlines('不是数组'), /不是数组/);
});

test('getKlines：成功写缓存并返回 network/stale=false', async () => {
  const dir = tmpDir();
  const r = await getKlines({
    symbol: 'btcusdt', interval: '1h', limit: 2, cacheDir: dir, now: NOW,
    fetchImpl: async () => res([kline(0, 10), kline(1, 11)]),
  });
  assert.equal(r.source, 'network');
  assert.equal(r.stale, false);
  assert.equal(r.bars.length, 2);
  assert.ok(fs.readdirSync(dir).some((f) => f === 'BTCUSDT_1h.json'));
  const cached = readCachedKlines({ symbol: 'BTCUSDT', interval: '1h', cacheDir: dir });
  assert.equal(cached.bars.length, 2);
});

test('getKlines：网络失败回退缓存并标 stale=true，附带错误信息', async () => {
  const dir = tmpDir();
  await getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 2, cacheDir: dir, now: NOW, fetchImpl: async () => res([kline(0, 10), kline(1, 11)]) });
  const r = await getKlines({
    symbol: 'BTCUSDT', interval: '1h', cacheDir: dir, now: NOW + 1000,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(r.source, 'cache');
  assert.equal(r.stale, true);
  assert.ok(r.error.includes('ECONNREFUSED'));
  assert.equal(r.bars.length, 2);
});

test('getKlines：失败且没有缓存 → 抛错（不假装有数据）', async () => {
  await assert.rejects(() => getKlines({
    symbol: 'BTCUSDT', interval: '1h', cacheDir: tmpDir(),
    fetchImpl: async () => { throw new Error('down'); },
  }), /行情抓取失败且无缓存/);
});

test('getKlines：limit 被夹到 1..1000；空数组视为失败', async () => {
  let url = '';
  await getKlines({
    symbol: 'BTCUSDT', interval: '1h', limit: 99999, cacheDir: tmpDir(),
    fetchImpl: async (u) => { url = u; return res([kline(0, 10)]); },
  });
  assert.ok(url.includes('limit=1000'));

  await assert.rejects(() => getKlines({
    symbol: 'BTCUSDT', interval: '1h', cacheDir: tmpDir(),
    fetchImpl: async () => res([]),
  }), /行情抓取失败且无缓存/);
});

test('getTicker：取最新价与 24h 统计；价格无效抛错', async () => {
  const t = await getTicker({
    symbol: 'BTCUSDT',
    fetchImpl: async () => res({ lastPrice: '100.5', priceChangePercent: '1.2', highPrice: '101', lowPrice: '99', volume: '1000' }),
  });
  assert.equal(t.price, 100.5);
  assert.equal(t.changePct, 1.2);
  assert.equal(t.symbol, 'BTCUSDT');
  await assert.rejects(() => getTicker({ symbol: 'BTCUSDT', fetchImpl: async () => res({ lastPrice: '0' }) }), /无有效价格/);
});

test('getSymbolRules：解析步长/最小量/价格精度/最小名义，缺字段给默认', async () => {
  const rules = await getSymbolRules({
    symbol: 'BTCUSDT',
    fetchImpl: async () => res({
      symbols: [{
        baseAsset: 'BTC', quoteAsset: 'USDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
          { filterType: 'PRICE_FILTER', tickSize: '0.1' },
          { filterType: 'NOTIONAL', minNotional: '10' },
        ],
      }],
    }),
  });
  assert.deepEqual(rules, {
    symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    stepSize: 0.001, minQty: 0.001, tickSize: 0.1, minNotional: 10,
  });

  const fallback = await getSymbolRules({ symbol: 'BTCUSDT', fetchImpl: async () => res({ symbols: [{ baseAsset: 'BTC', quoteAsset: 'USDT' }] }) });
  assert.equal(fallback.stepSize, 0.00001);
  assert.equal(fallback.minNotional, 5);

  await assert.rejects(() => getSymbolRules({ symbol: 'BTCUSDT', fetchImpl: async () => res({ symbols: [] }) }), /exchangeInfo 没有/);
});
