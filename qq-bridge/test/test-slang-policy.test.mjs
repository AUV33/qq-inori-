import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSlangExtraction, hasUrgentSignal, SLANG_POLICY_DEFAULTS } from '../src/domain/leaves/inori-slang-policy.js';

const MIN = 10;
const COOLDOWN = 60 * 60 * 1000;
const URGENT = 10 * 60 * 1000;
const T0 = 1_800_000_000_000;

test('消息不够 minMessages 时不提取（即使生词信号为真）', () => {
  const d = decideSlangExtraction({ lastAt: 0 }, {
    now: T0, messageCount: 9, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(d.extract, false);
  assert.equal(d.reason, 'too-few');
});

test('普通冷却到点就提取（60 分钟）', () => {
  const d = decideSlangExtraction({ lastAt: T0 - COOLDOWN, hourStart: T0, hourCount: 0 }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN,
  });
  assert.equal(d.extract, true);
  assert.equal(d.reason, 'regular');
  assert.equal(d.next.lastAt, T0);
  assert.equal(d.next.hourCount, 1);
});

test('有生词信号时 10 分钟就能提前提取', () => {
  const d = decideSlangExtraction({ lastAt: T0 - URGENT, hourStart: T0 - URGENT, hourCount: 0 }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(d.extract, true);
  assert.equal(d.reason, 'urgent');
});

test('生词信号也不能突破 urgent 冷却', () => {
  const d = decideSlangExtraction({ lastAt: T0 - URGENT + 1000, hourStart: T0, hourCount: 0 }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(d.extract, false);
  assert.equal(d.reason, 'urgent-cooldown');
});

test('没有生词信号时只能等普通冷却', () => {
  const d = decideSlangExtraction({ lastAt: T0 - URGENT }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: false,
  });
  assert.equal(d.extract, false);
  assert.equal(d.reason, 'cooldown');
});

test('每小时上限挡住超额 urgent，普通冷却仍可过', () => {
  const capped = decideSlangExtraction({ lastAt: T0 - URGENT, hourStart: T0 - 1000, hourCount: SLANG_POLICY_DEFAULTS.maxPerHour }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(capped.extract, false);
  assert.equal(capped.reason, 'hour-cap');

  const regular = decideSlangExtraction({ lastAt: T0 - COOLDOWN, hourStart: T0 - 1000, hourCount: 99 }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(regular.extract, true);
  assert.equal(regular.reason, 'regular');
});

test('跨小时自动清零计数', () => {
  const d = decideSlangExtraction({ lastAt: T0 - URGENT, hourStart: T0 - 3600_000, hourCount: 3 }, {
    now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true,
  });
  assert.equal(d.extract, true);
  assert.equal(d.reason, 'urgent');
  assert.equal(d.next.hourCount, 1);
});

test('不改传入的 state（纯函数）', () => {
  const st = { lastAt: 5, hourStart: 7, hourCount: 1 };
  decideSlangExtraction(st, { now: T0, messageCount: MIN, minMessages: MIN, cooldownMs: COOLDOWN, urgent: true });
  assert.deepEqual(st, { lastAt: 5, hourStart: 7, hourCount: 1 });
});

test('hasUrgentSignal：窗口里重复出现的生词算信号', () => {
  const messages = [
    { text: '牛马' },
    { text: '牛马啊' },
    { text: '真牛马' },
  ];
  assert.equal(hasUrgentSignal(messages, '', { minMessages: 3 }), true);
});

test('hasUrgentSignal：已知词不算信号', () => {
  const messages = [
    { text: '牛马' },
    { text: '牛马啊' },
    { text: '真牛马' },
  ];
  assert.equal(hasUrgentSignal(messages, '牛马', { minMessages: 3 }), false);
});

test('hasUrgentSignal：消息条数不够不算信号', () => {
  assert.equal(hasUrgentSignal([{ text: '牛马' }, { text: '牛马' }], '', { minMessages: 3 }), false);
});
