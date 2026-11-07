// model-prices 金标：峰谷分时判定（北京时间/节假日）、价目表合并、usage 归一与计费。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_TABLE_VERSION, CN_HOLIDAYS, DEFAULT_PRICE_TABLE, resolvePriceTable, beijingParts, isPeakAt, ratesAt,
  normalizeUsage, totalTokensOf, costOfBuckets, priceUsage, ZERO_BUCKETS, addBuckets,
} from '../src/domain/persona/model-prices.js';

const utc = (s) => Date.parse(s);

test('常量：版本标记、节假日覆盖 2026/2027 两年', () => {
  assert.equal(PRICE_TABLE_VERSION, DEFAULT_PRICE_TABLE.version);
  assert.ok(CN_HOLIDAYS.includes('2026-10-01'));
  assert.ok(CN_HOLIDAYS.includes('2027-02-06'));
  assert.ok(CN_HOLIDAYS.length > 30);
});

test('beijingParts：按 UTC+8 换算，周日映射成 7', () => {
  const p = beijingParts(utc('2026-11-02T01:30:00Z')); // 周一 09:30 北京
  assert.equal(p.weekday, 1);
  assert.equal(p.hour, 9);
  assert.equal(p.date, '2026-11-02');
  assert.equal(p.clock, '09:30');

  const sunday = beijingParts(utc('2026-11-01T04:00:00Z'));
  assert.equal(sunday.weekday, 7);
});

test('isPeakAt：工作日 9-12、14-18 的双半开窗口', () => {
  assert.equal(isPeakAt(utc('2026-11-02T01:00:00Z')), true, '周一 09:00');
  assert.equal(isPeakAt(utc('2026-11-02T03:59:00Z')), true, '周一 11:59');
  assert.equal(isPeakAt(utc('2026-11-02T04:00:00Z')), false, '周一 12:00 窗口是右开');
  assert.equal(isPeakAt(utc('2026-11-02T06:00:00Z')), true, '周一 14:00');
  assert.equal(isPeakAt(utc('2026-11-02T09:59:00Z')), true, '周一 17:59');
  assert.equal(isPeakAt(utc('2026-11-02T10:00:00Z')), false, '周一 18:00');
  assert.equal(isPeakAt(utc('2026-11-02T05:00:00Z')), false, '午休 13:00');
});

test('isPeakAt：周末与法定节假日全天算空闲', () => {
  assert.equal(isPeakAt(utc('2026-11-07T03:00:00Z')), false, '周六 11:00');
  assert.equal(isPeakAt(utc('2026-10-01T03:00:00Z')), false, '国庆 11:00');
  assert.equal(isPeakAt(NaN), false, '非法时间不算高峰');
});

test('isPeakAt：节假日本身是 Set 也认', () => {
  const table = { ...DEFAULT_PRICE_TABLE, holidays: new Set(['2026-11-02']) };
  assert.equal(isPeakAt(utc('2026-11-02T03:00:00Z'), table), false);
});

test('ratesAt：空闲价与高峰价（×peakMultiplier），带时段标签', () => {
  const off = ratesAt('deepseek-flash', utc('2026-11-02T11:00:00Z'));
  assert.equal(off.tier, 'off');
  assert.equal(off.cacheMiss, 1);
  assert.equal(off.output, 4);
  assert.equal(off.estimated, false);

  const peak = ratesAt('deepseek-flash', utc('2026-11-02T03:00:00Z'));
  assert.equal(peak.tier, 'peak');
  assert.equal(peak.cacheMiss, 2);
  assert.equal(peak.output, 8);
  assert.equal(peak.tierLabel, '高峰时段');
});

test('ratesAt：未知模型回落 fallback 并标 estimated=true', () => {
  const r = ratesAt('不存在的模型', utc('2026-11-02T11:00:00Z'));
  assert.equal(r.model, '不存在的模型', '原样回显，便于排查');
  assert.equal(r.estimated, true);
  assert.equal(r.cacheMiss, DEFAULT_PRICE_TABLE.models[DEFAULT_PRICE_TABLE.fallbackModel].off.cacheMiss);
  assert.equal(ratesAt('', utc('2026-11-02T11:00:00Z')).model, DEFAULT_PRICE_TABLE.fallbackModel);
});

test('resolvePriceTable：无覆盖时返回默认表的副本；覆盖项按模型合并', () => {
  const base = resolvePriceTable(null);
  assert.equal(base.version, PRICE_TABLE_VERSION);
  base.models['deepseek-flash'].off.cacheMiss = 999;
  assert.equal(DEFAULT_PRICE_TABLE.models['deepseek-flash'].off.cacheMiss, 1, '不能改到默认表');

  const merged = resolvePriceTable({ peakMultiplier: 3, models: { 'deepseek-flash': { label: '自定义', off: { output: 9 } } } });
  assert.equal(merged.peakMultiplier, 3);
  assert.equal(merged.models['deepseek-flash'].label, '自定义');
  assert.equal(merged.models['deepseek-flash'].off.output, 9);
  assert.equal(merged.models['deepseek-flash'].off.cacheMiss, 1, '未覆盖的字段沿用默认');
});

test('resolvePriceTable：cacheWrite 只在条目自己没写时才跟随 cacheMiss', () => {
  const inherit = resolvePriceTable({ models: { m1: { off: { cacheMiss: 7 } } } });
  assert.equal(inherit.models.m1.off.cacheWrite, 7);

  const explicit = resolvePriceTable({ models: { m2: { off: { cacheMiss: 7, cacheWrite: 3 } } } });
  assert.equal(explicit.models.m2.off.cacheWrite, 3);
});

test('resolvePriceTable：非法 peakMultiplier/unit/version/fallbackModel 都回落默认', () => {
  const t = resolvePriceTable({ peakMultiplier: 0, unit: -1, version: '', fallbackModel: '不存在的' });
  assert.equal(t.peakMultiplier, 2);
  assert.equal(t.unit, 1e6);
  assert.equal(t.version, PRICE_TABLE_VERSION);
  assert.equal(t.fallbackModel, DEFAULT_PRICE_TABLE.fallbackModel);
});

test('normalizeUsage：两种键名都认（DSH 原始口径与账本口径）', () => {
  const dsh = normalizeUsage({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 5 });
  assert.deepEqual(dsh, { cacheMiss: 100, cacheHit: 50, cacheWrite: 10, output: 20, reasoning: 5 });

  const ledger = normalizeUsage({ cacheMiss: 7, cacheHit: 3, cacheWrite: 1, output: 2 });
  assert.deepEqual(ledger, { cacheMiss: 7, cacheHit: 3, cacheWrite: 1, output: 2, reasoning: 0 });

  assert.deepEqual(normalizeUsage(null), ZERO_BUCKETS);
  assert.deepEqual(normalizeUsage({ inputTokens: -5, outputTokens: 'abc' }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  assert.equal(normalizeUsage({ inputTokens: 10.7 }).cacheMiss, 11, '四舍五入');
});

test('totalTokensOf / addBuckets / ZERO_BUCKETS', () => {
  assert.equal(totalTokensOf({ cacheMiss: 1, cacheHit: 2, cacheWrite: 3, output: 4 }), 10);
  assert.equal(totalTokensOf(null), 0);
  const sum = addBuckets({ cacheMiss: 1, cacheHit: 2, output: 3 }, { cacheMiss: 10, output: 30, reasoning: 5 });
  assert.deepEqual(sum, { cacheMiss: 11, cacheHit: 2, cacheWrite: 0, output: 33, reasoning: 5 });
  assert.deepEqual(ZERO_BUCKETS, { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
});

test('costOfBuckets：按百万 token 单价分桶计价再相加', () => {
  const rates = ratesAt('deepseek-flash', utc('2026-11-02T11:00:00Z'));
  const cost = costOfBuckets({ cacheMiss: 1e6, cacheHit: 1e6, cacheWrite: 1e6, output: 1e6 }, rates);
  assert.equal(cost.cacheMiss, 1);
  assert.equal(cost.cacheHit, 0.02);
  assert.equal(cost.cacheWrite, 1);
  assert.equal(cost.output, 4);
  assert.equal(cost.total, 6.02);
  assert.deepEqual(costOfBuckets(null, rates).total, 0);
});

test('priceUsage：一步算出速率与金额（高峰翻倍）', () => {
  const off = priceUsage({ cacheMiss: 1e6, output: 1e6 }, { model: 'deepseek-flash', at: utc('2026-11-02T11:00:00Z') });
  assert.equal(off.cost.total, 5);
  const peak = priceUsage({ cacheMiss: 1e6, output: 1e6 }, { model: 'deepseek-flash', at: utc('2026-11-02T03:00:00Z') });
  assert.equal(peak.cost.total, 10);
});
