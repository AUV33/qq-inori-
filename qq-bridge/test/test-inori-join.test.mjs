// inori-join 金标：活跃群里"插话/接着聊"的判定——只决定要不要递事实，不决定她说什么。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOIN_DEFAULTS, ENGAGE_DEFAULTS, decideJoin, decideContinue, renderRecentLines } from '../src/domain/leaves/inori-join.js';

const NOW = 1_800_000_000_000;
const MIN = 60000;

test('decideJoin：群不热闹/她刚说过话/太快/超小时上限/适应度低 → 都不给机会', () => {
  const base = { now: NOW, othersRecent: 12, lastSelfAt: 0, lastJoinAt: 0, adaptive: 0.4, joinTimes: [], random: 0 };
  assert.equal(decideJoin({ ...base, othersRecent: 3 }).why, 'group-not-active');
  assert.equal(decideJoin({ ...base, lastSelfAt: NOW - 5 * MIN }).why, 'she-just-spoke');
  assert.equal(decideJoin({ ...base, lastJoinAt: NOW - 2 * MIN }).why, 'too-soon');
  assert.equal(decideJoin({ ...base, adaptive: 0.05 }).why, 'low-adaptive');
  assert.equal(decideJoin({ ...base, joinTimes: Array.from({ length: 3 }, () => NOW - 1000) }).why, 'hour-cap');
  assert.equal(decideJoin({ ...base, random: 0.99 }).why, 'dice', '掷骰没过');
  assert.equal(decideJoin(base, { enabled: false }).why, 'disabled');
});

test('decideJoin：条件都满足时给一次插话机会', () => {
  const r = decideJoin({ now: NOW, othersRecent: 12, lastSelfAt: NOW - 20 * MIN, lastJoinAt: NOW - 20 * MIN, adaptive: 0.4, joinTimes: [], random: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.why, 'join');
  assert.ok(r.p > 0 && r.p <= JOIN_DEFAULTS.maxProb);
});

test('decideJoin：越热闹、适应度越高，概率越高但封顶 maxProb', () => {
  const base = { now: NOW, lastSelfAt: NOW - 20 * MIN, lastJoinAt: NOW - 20 * MIN, joinTimes: [], random: 0.3 };
  const quietish = decideJoin({ ...base, othersRecent: 8, adaptive: 0.12 }).p;
  const busy = decideJoin({ ...base, othersRecent: 20, adaptive: 0.6 }).p;
  assert.ok(busy > quietish);
  assert.ok(busy <= JOIN_DEFAULTS.maxProb + 1e-9);
});

test('decideJoin：缺少 now 时用当前时间；lastSelfAt=0 视为从没说过', () => {
  const r = decideJoin({ othersRecent: 9, lastSelfAt: 0, lastJoinAt: 0, adaptive: 0.5, joinTimes: [], random: 0 });
  assert.equal(r.ok, true);
});

test('decideContinue：从没说过/窗口过了/没有新消息/太快/超每小时上限 → 都不递', () => {
  const base = { now: NOW, lastSelfAt: NOW - 2 * MIN, newOthers: 2, continueTimes: [] };
  assert.equal(decideContinue({ ...base, lastSelfAt: 0 }).why, 'never-spoke');
  assert.equal(decideContinue({ ...base, lastSelfAt: NOW - 30 * MIN }).why, 'window-over');
  assert.equal(decideContinue({ ...base, newOthers: 0 }).why, 'nothing-new');
  assert.equal(decideContinue({ ...base, continueTimes: [NOW - 10_000] }).why, 'too-soon');
  // 12 次都在 1 小时内、且都超过 45 秒最小间隔 → 撞每小时上限
  assert.equal(decideContinue({ ...base, continueTimes: Array.from({ length: 12 }, () => NOW - 50_000) }).why, 'hour-cap');
  assert.equal(decideContinue(base, { enabled: false }).why, 'disabled');
});

test('decideContinue：刚说过话且有人接着说了 → 递一次延续（不掷骰子）', () => {
  const r = decideContinue({ now: NOW, lastSelfAt: NOW - 2 * MIN, newOthers: 2, continueTimes: [] });
  assert.equal(r.ok, true);
  assert.equal(r.why, 'continue');
});

test('renderRecentLines：压成「谁：说了什么」，自己的标「你」，最多 max 条且截断', () => {
  const messages = [
    { sender: 'A', text: '第一句' },
    { isSelf: true, text: '我说的' },
    { sender: '', text: '没名字' },
    { text: '   ' },
    { sender: 'B', text: '长'.repeat(100) },
  ];
  const lines = renderRecentLines(messages, { max: 3, chars: 10 });
  assert.equal(lines.length, 3, '取最后 3 条（max）');
  assert.ok(lines[0].includes('你：我说的'), lines[0]);
  assert.ok(lines[1].includes('某人：没名字'), lines[1]);
  assert.ok(lines[2].includes('B：'));
  assert.ok(lines[2].length <= 10 + 4, '正文截断到 chars');

  assert.deepEqual(renderRecentLines([]), []);
  assert.deepEqual(renderRecentLines(null), []);
});

test('默认参数是设计值（插话：10 分钟窗口/每小时 3 次；延续：45 秒间隔/每小时 12 次）', () => {
  assert.equal(JOIN_DEFAULTS.windowMs, 10 * MIN);
  assert.equal(JOIN_DEFAULTS.maxPerHour, 3);
  assert.equal(ENGAGE_DEFAULTS.minGapMs, 45 * 1000);
  assert.equal(ENGAGE_DEFAULTS.maxPerHour, 12);
});

test('decideJoin：条件都满足时概率有下限（不是永远 0）', () => {
  const r = decideJoin({ now: NOW, othersRecent: 12, lastSelfAt: NOW - 20 * MIN, adaptive: 0.25, joinTimes: [], random: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.p > 0.35, `放行时概率应有意义地大于 0.35，实际 ${r.p}`);
});
