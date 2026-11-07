// [FORCE-NAP] 睡眠债顶格死循环的回归锁：
//   债长期 1.0 时，自然入睡（困意 ≥0.85）在白天永远不会触发 → [motive] 永久闭嘴。
//   这里锁住「债顶格 30 分钟 → 强制小睡 → 睡够 90 分钟且债 ≤0.7 → 醒」，
//   以及「夜间自然睡仍按早晨窗口醒」不被带偏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { physTick } from '../src/domain/leaves/inori-lifestate.js';

const at = (h, m) => new Date(2026, 9, 30, h, m, 0, 0).getTime(); // 本地时间 2026-10-30

function freshState(now, extra = {}) {
  return {
    state: 'active',
    stateChanged: now,
    sleepSince: null,
    sleepOrigin: null,
    wakeUntil: 0,
    debt: 1,
    highDebtSince: 0,
    lastPhysTick: now,
    sleepLog: [],
    driftDays: 0,
    driftCheckedDay: '2026-10-30',
    sleepNotes: 0,
    activeAfterSleep: 0,
    at: now,
    enabled: true,
    ...extra,
  };
}

function runTicks(state, start, minutes, stepMin = 5, cfg = {}) {
  let s = state;
  const events = [];
  for (let i = 1; i <= minutes / stepMin; i += 1) {
    const now = start + i * stepMin * 60000;
    const r = physTick(s, now, cfg);
    s = r.state;
    for (const e of r.events) events.push({ ...e, at: now });
  }
  return { state: s, events };
}

test('[FORCE-NAP] 白天债 1.0 持续 30 分钟 → 强制小睡（不用等困意过线）', () => {
  const t0 = at(17, 0);
  // 第一次 tick 才记录「顶格起点」，所以要多跑 5 分钟才满 30 分钟
  const { state, events } = runTicks(freshState(t0), t0, 35, 5, { quietForMs: 60 * 60000 });
  const sleeps = events.filter((e) => e.type === 'auto_sleep');
  assert.equal(sleeps.length, 1, `应强制入睡一次，实际 ${JSON.stringify(events)}`);
  assert.equal(sleeps[0].origin, 'force');
  assert.equal(state.state, 'sleep');
  assert.equal(state.sleepOrigin, 'force');
});

test('[FORCE-NAP] 小睡 90 分钟后债 ≤0.7 → 醒（不会躺到第二天早上）', () => {
  const t0 = at(17, 0);
  const early = runTicks(freshState(t0), t0, 35, 5, { quietForMs: 60 * 60000 });
  assert.equal(early.state.state, 'sleep');
  // 再睡 90 分钟
  const r = runTicks(early.state, t0 + 35 * 60000, 90, 5, { quietForMs: 60 * 60000 });
  const wakes = r.events.filter((e) => e.type === 'auto_wake');
  assert.equal(wakes.length, 1, `应醒一次，实际 ${JSON.stringify(r.events)}`);
  assert.equal(r.state.state, 'idle');
  assert.ok(r.state.debt <= 0.7, `醒来债应 ≤0.7，实际 ${r.state.debt}`);
  assert.equal(r.state.highDebtSince, 0, '醒来后清掉顶格起点');
});

test('[FORCE-NAP] 夜间自然入睡按早晨窗口醒，不被小睡规则带偏', () => {
  const t0 = at(23, 30);
  // 债 0.9、夜里压力高 → 自然入睡（origin=auto）
  const first = physTick(freshState(t0, { debt: 0.9 }), t0 + 5 * 60000);
  assert.equal(first.state.state, 'sleep');
  assert.equal(first.state.sleepOrigin, 'auto');
  // 01:30 —— 债已降到 0.4，但不是早晨、也不是 force，不该醒
  const night = runTicks(first.state, t0 + 5 * 60000, 120);
  assert.equal(night.state.state, 'sleep', '半夜不该醒');
  // 05:40 —— 早晨窗口 + 睡够 6h → 醒
  const dawn = runTicks(night.state, t0 + 125 * 60000, 240);
  const wake = dawn.events.find((e) => e.type === 'auto_wake');
  assert.ok(wake, `05:40 后应醒，实际 ${JSON.stringify(dawn.events)}`);
});

test('[FORCE-NAP] 刚被叫醒的 45 分钟窗口内，债顶格仍允许强制睡', () => {
  const t0 = at(15, 0);
  const s = freshState(t0, {
    state: 'waking',
    wakeUntil: t0 + 45 * 60000,
    highDebtSince: t0 - 40 * 60000,
  });
  const r = physTick(s, t0 + 60000, { quietForMs: 60 * 60000 });
  assert.equal(r.state.state, 'sleep', '强制小睡不受唤醒窗口限制');
  assert.equal(r.state.sleepOrigin, 'force');
});

test('[FORCE-NAP] 刚有人找过她（不安静）→ 债顶格也不睡', () => {
  const t0 = at(17, 0);
  const { state, events } = runTicks(freshState(t0), t0, 40, 5, { quietForMs: 5 * 60000 });
  assert.equal(events.filter((e) => e.type === 'auto_sleep').length, 0, '对话中不该强制睡');
  assert.equal(state.state, 'active');
});
