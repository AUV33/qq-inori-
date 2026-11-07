// own-life 金标：「她自己的时间」调度 —— 安静时段/生活门/额度/半夜槽位/忙推延/饥饿保底/节奏热读/落盘。
// 用 mkdtemp 的临时状态与提示词目录（不读不写仓库 data/、state/）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ownlife-'));
const promptDir = path.join(tmpRoot, 'prompts');
fs.mkdirSync(promptDir, { recursive: true });
// 必须在 import own-life 之前设置：inori-prompts 的 DEFAULT_DIR 与 learning-store 的趋势文件都在模块加载时取
const originalPromptDir = process.env.PROMPT_DIR;
const originalTrend = process.env.LEARNING_TREND;
process.env.PROMPT_DIR = promptDir;
process.env.LEARNING_TREND = path.join(tmpRoot, 'learning-trend.jsonl');
const { createOwnLife, DEFAULT_TEXT_DAY, DEFAULT_TEXT_MIDNIGHT } = await import('../src/domain/social/own-life.js');

after(() => {
  if (originalPromptDir === undefined) delete process.env.PROMPT_DIR; else process.env.PROMPT_DIR = originalPromptDir;
  if (originalTrend === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = originalTrend;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const HOUR = 3600 * 1000;
const at = (h, mi = 0, y = 2026, mo = 1, d = 5) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const dayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let seq = 0;
function makeLife({ state, rhythmPath, ...overrides } = {}) {
  const delivered = [];
  const logs = [];
  const statePath = path.join(tmpRoot, `state-${++seq}.json`);
  if (state !== undefined) fs.writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state), 'utf8');
  const life = createOwnLife({
    key: 'private:1',
    deliver: async (text) => { delivered.push(text); },
    statePath,
    log: (...a) => logs.push(a.join(' ')),
    ...(rhythmPath ? { rhythmPath } : {}),
    ...overrides,
  });
  return { life, delivered, logs, statePath, rhythmPath };
}

function rhythmFile(rhythmPath, value) {
  fs.writeFileSync(rhythmPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

// ───────────────────────── 构造与默认值 ─────────────────────────

test('构造：缺 key / 缺 deliver 立刻抛', () => {
  assert.throws(() => createOwnLife({ deliver: () => {} }), /own-life: 缺 key/);
  assert.throws(() => createOwnLife({ key: 'private:1' }), /own-life: 缺 deliver/);
  assert.throws(() => createOwnLife(), /own-life: 缺 key/);
  assert.throws(() => createOwnLife({ key: 'private:1', deliver: 'not-a-fn' }), /own-life: 缺 deliver/);
});

test('默认提示词：白天/半夜两套都非空，半夜版是更短的复盘版', () => {
  assert.equal(typeof DEFAULT_TEXT_DAY, 'string');
  assert.equal(typeof DEFAULT_TEXT_MIDNIGHT, 'string');
  assert.ok(DEFAULT_TEXT_DAY.length > 100);
  assert.ok(DEFAULT_TEXT_MIDNIGHT.length > 40);
  assert.ok(DEFAULT_TEXT_MIDNIGHT.length < DEFAULT_TEXT_DAY.length);
  assert.ok(DEFAULT_TEXT_DAY.includes('不用回我'));
  assert.ok(DEFAULT_TEXT_DAY.includes('video_feed'));
  assert.ok(DEFAULT_TEXT_MIDNIGHT.includes('半夜了'));
});

test('snapshot：默认间隔/安静窗/半夜点/额度都是文档值', () => {
  const { life } = makeLife();
  const snap = life.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.intervalMs, HOUR);
  assert.deepEqual(snap.quiet, [3, 8]);
  assert.equal(snap.midnightAt, '23:30');
  assert.equal(snap.lastFiredAt, 0);
  assert.equal(snap.lastDay, '');
  assert.equal(snap.firedToday, 0);
  assert.equal(snap.droppedTotal, 0);
  assert.equal(snap.rhythm.intervalMs, HOUR);
  assert.deepEqual(snap.rhythm.quiet, [3, 8]);
  assert.equal(typeof snap.rhythm.ts, 'number');
});

// ───────────────────────── 投递与落盘 ─────────────────────────

test('fireNow：投白天提示、推进状态并原子落盘', async () => {
  const h = makeLife();
  const r = await h.life.fireNow();
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'day');
  assert.equal(typeof r.at, 'number');
  assert.deepEqual(h.delivered, [DEFAULT_TEXT_DAY]);

  const snap = h.life.snapshot();
  assert.equal(snap.firedToday, 1);
  assert.equal(snap.lastFiredAt, r.at);
  assert.equal(snap.lastDay, dayOf(r.at));

  const saved = JSON.parse(fs.readFileSync(h.statePath, 'utf8'));
  assert.equal(saved.firedToday, 1);
  assert.equal(saved.lastFiredAt, r.at);
  assert.ok(h.logs.some((l) => l.includes('已投递（day）') && l.includes('今天第 1 次')));
});

test('fireMidnightNow：投半夜提示、不占白天额度、记 lastMidnightDay', async () => {
  const h = makeLife();
  await h.life.fireNow();
  const r = await h.life.fireMidnightNow();
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'midnight');
  assert.deepEqual(h.delivered, [DEFAULT_TEXT_DAY, DEFAULT_TEXT_MIDNIGHT]);
  const snap = h.life.snapshot();
  assert.equal(snap.firedToday, 1, '半夜槽位不占白天额度');
  assert.equal(snap.lastMidnightDay, dayOf(r.at));
  assert.equal(snap.lastFiredAt, r.at);
});

test('状态恢复：坏 JSON / null / 半截字段都不炸，坏文件下次被覆盖', async () => {
  const broken = makeLife({ state: '{这不是 JSON' });
  assert.equal(broken.life.snapshot().firedToday, 0);
  const r = await broken.life.fireNow();
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(broken.statePath, 'utf8')).firedToday, 1, '坏文件被合法状态覆盖');

  const nullish = makeLife({ state: 'null' });
  assert.equal(nullish.life.snapshot().firedToday, 0);
  assert.equal((await nullish.life.fireNow()).ok, true);

  const partial = makeLife({ state: { firedToday: 2, lastDay: '2000-01-01', droppedTotal: 3 } });
  const snap = partial.life.snapshot();
  assert.equal(snap.firedToday, 2);
  assert.equal(snap.droppedTotal, 3);
  assert.equal(snap.lastFiredAt, 0, '缺的字段用默认值补齐');
});

test('fire：投递失败返回 error、不推进状态，busy 释放后还能再投', async () => {
  let fail = true;
  const delivered = [];
  const logs = [];
  const h = makeLife({
    deliver: async (text) => { if (fail) throw new Error('DSH 不在'); delivered.push(text); },
    log: (...a) => logs.push(a.join(' ')),
  });
  const bad = await h.life.fireNow();
  assert.deepEqual(bad, { ok: false, error: 'DSH 不在' });
  const snap = h.life.snapshot();
  assert.equal(snap.firedToday, 0, '失败不占额度');
  assert.equal(snap.lastFiredAt, 0);
  assert.ok(logs.some((l) => l.includes('投递失败: DSH 不在')));

  fail = false;
  const good = await h.life.fireNow();
  assert.equal(good.ok, true);
  assert.equal(h.life.snapshot().firedToday, 1);
  assert.equal(delivered.length, 1);
});

test('fire：上一次还没投完时再次触发 → busy，不重复投递', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const delivered = [];
  const h = makeLife({ deliver: async (t) => { delivered.push(t); await gate; } });
  const first = h.life.fireNow();
  assert.deepEqual(await h.life.fireNow(), { ok: false, skipped: 'busy' });
  release();
  assert.equal((await first).ok, true);
  assert.equal(delivered.length, 1);
});

test('textDay/textMidnight 可注入（配置覆盖默认提示词）', async () => {
  const h = makeLife({ textDay: 'CUSTOM-DAY', textMidnight: 'CUSTOM-NIGHT' });
  await h.life.fireNow();
  await h.life.fireMidnightNow();
  assert.deepEqual(h.delivered, ['CUSTOM-DAY', 'CUSTOM-NIGHT']);
});

test('提示词热加载：data 目录文件优先级最高，空文件/异常回落到注入文本', async () => {
  const h = makeLife({ textDay: 'FALLBACK-DAY', textMidnight: 'FALLBACK-NIGHT' });
  const dayFile = path.join(promptDir, 'ownlife-day.md');
  const nightFile = path.join(promptDir, 'ownlife-night.md');
  try {
    fs.writeFileSync(dayFile, 'HOT-DAY\n', 'utf8');
    fs.writeFileSync(nightFile, 'HOT-NIGHT\r\n', 'utf8');
    await h.life.fireNow();
    await h.life.fireMidnightNow();
    assert.deepEqual(h.delivered, ['HOT-DAY', 'HOT-NIGHT'], '文件优先且换行归一');

    fs.writeFileSync(dayFile, '   \n', 'utf8');
    await h.life.fireNow();
    assert.equal(h.delivered.at(-1), 'FALLBACK-DAY', '空文件回落');
  } finally {
    fs.rmSync(dayFile, { force: true });
    fs.rmSync(nightFile, { force: true });
  }
});

// ───────────────────────── tick 门禁 ─────────────────────────

test('tick：enabled=false 直接 disabled，不碰任何状态', async () => {
  const h = makeLife({ enabled: false });
  const r = await h.life.tick(at(14));
  assert.deepEqual(r, { ok: false, skipped: 'disabled' });
  assert.equal(h.delivered.length, 0);
  assert.equal(h.life.snapshot().firedToday, 0);
});

test('tick：默认安静时段 3:00–8:00（左闭右开）不叫', async () => {
  const quiet = makeLife();
  assert.deepEqual(await quiet.life.tick(at(3)), { ok: false, skipped: 'quiet' });
  assert.equal(quiet.delivered.length, 0, '3 点整算安静');

  const stillQuiet = makeLife();
  assert.deepEqual(await stillQuiet.life.tick(at(7, 59)), { ok: false, skipped: 'quiet' });

  const wake = makeLife();
  const r = await wake.life.tick(at(8));
  assert.equal(r.ok, true, '8 点整解除安静');
  assert.equal(wake.delivered.length, 1);
});

test('tick：跨夜安静窗 [23,7] 也能正确判断', async () => {
  const late = makeLife({ quiet: [23, 7] });
  assert.deepEqual(await late.life.tick(at(23, 30)), { ok: false, skipped: 'quiet' });
  const early = makeLife({ quiet: [23, 7] });
  assert.deepEqual(await early.life.tick(at(3)), { ok: false, skipped: 'quiet' });
  const noon = makeLife({ quiet: [23, 7] });
  assert.equal((await noon.life.tick(at(12))).ok, true, '12 点不在跨夜窗里');
});

test('tick：睡着（生活门 sleeping）跳过且不计积压；旧布尔门仍然兼容', async () => {
  const sleeping = makeLife({ getLifeGate: () => 'sleeping' });
  assert.deepEqual(await sleeping.life.tick(at(14)), { ok: false, skipped: 'sleeping' });
  assert.equal(sleeping.delivered.length, 0);
  assert.equal(sleeping.life.snapshot().firedToday, 0, '睡着不补时、不占额度');

  const legacySkip = makeLife({ getLifeGate: () => 'unknown', getShouldSkip: () => true });
  assert.deepEqual(await legacySkip.life.tick(at(14)), { ok: false, skipped: 'sleeping' });

  const legacyPass = makeLife({ getLifeGate: () => 'unknown', getShouldSkip: () => false });
  assert.equal((await legacyPass.life.tick(at(14))).ok, true);
});

test('tick：犯困（drowsy）不发起新事，把机会推延并落盘 dueAt', async () => {
  const t0 = at(14);
  const h = makeLife({
    getLifeGate: () => 'drowsy',
    state: { lastDay: dayOf(t0), lastFiredAt: t0 - 90 * 60000, dueAt: t0 - 90 * 60000 },
  });
  const r = await h.life.tick(t0);
  assert.deepEqual(r, { ok: false, skipped: 'deferred', deferred: 1 });
  assert.equal(h.delivered.length, 0);
  const snap = h.life.snapshot();
  assert.equal(snap.dueAt, t0 - 90 * 60000, '到点时刻要持久化，下一跳继续重试');
  assert.equal(snap.deferred, 1);
  assert.ok(h.logs.some((l) => l.includes('往后推延（犯困，已积压 1/2 轮）')));
});

test('tick：会话忙（isBusy）推延，积压按错过的整轮数算', async () => {
  const t0 = at(14);
  const h = makeLife({
    isBusy: () => true,
    state: { lastDay: dayOf(t0), lastFiredAt: t0 - 150 * 60000, dueAt: t0 - 150 * 60000 },
  });
  const r = await h.life.tick(t0);
  assert.deepEqual(r, { ok: false, skipped: 'deferred', deferred: 2 });
  assert.ok(h.logs.some((l) => l.includes('往后推延（会话忙，已积压 2/2 轮）')));
});

test('tick：推延日志按 deferLogEveryMs 限流', async () => {
  const t0 = at(14);
  const h = makeLife({
    isBusy: () => true,
    deferLogEveryMs: 10 * 60000,
    state: { lastDay: dayOf(t0), lastFiredAt: t0 - 90 * 60000, dueAt: t0 - 90 * 60000 },
  });
  await h.life.tick(t0);
  const firstCount = h.logs.filter((l) => l.includes('往后推延')).length;
  await h.life.tick(t0 + 1000);
  assert.equal(h.logs.filter((l) => l.includes('往后推延')).length, firstCount, '10 分钟内不重复刷日志');
  await h.life.tick(t0 + 11 * 60000);
  assert.equal(h.logs.filter((l) => l.includes('往后推延')).length, firstCount + 1, '窗口过了再记一条');
});

test('tick：积压超过 maxDefer → 放弃一次、回调 onDrop、10 分钟后重试', async () => {
  const t0 = at(14);
  const drops = [];
  const h = makeLife({
    isBusy: () => true,
    maxDefer: 2,
    dropBackoffMs: 10 * 60000,
    onDrop: async (info) => drops.push(info),
    state: { lastDay: dayOf(t0), lastFiredAt: t0 - 3 * HOUR, dueAt: t0 - 3 * HOUR },
  });
  const r = await h.life.tick(t0);
  assert.deepEqual(r, { ok: false, skipped: 'dropped', pending: 3 });
  assert.equal(h.delivered.length, 0);
  assert.deepEqual(drops, [{ at: t0, count: 3, total: 1 }]);
  const snap = h.life.snapshot();
  assert.equal(snap.droppedTotal, 1);
  assert.equal(snap.dueAt, t0 + 10 * 60000, '放弃后 10 分钟再试，不吃掉整个间隔');
  assert.equal(snap.deferred, 0);
  assert.ok(h.logs.some((l) => l.includes('已经积压 3 轮都在忙，这次独处机会放弃')));

  // 空档来了：回退时刻一到就能投出去
  const later = makeLife({ state: { lastDay: dayOf(t0), droppedTotal: 1, dueAt: snap.dueAt, lastFiredAt: t0 } });
  assert.equal((await later.life.tick(t0 + 10 * 60000)).ok, true);
});

test('tick：onDrop 抛错也被吞掉，不影响放弃流程', async () => {
  const t0 = at(14);
  const h = makeLife({
    isBusy: () => true,
    maxDefer: 2,
    onDrop: async () => { throw new Error('记忆写不进'); },
    state: { lastDay: dayOf(t0), lastFiredAt: t0 - 3 * HOUR, dueAt: t0 - 3 * HOUR },
  });
  assert.deepEqual(await h.life.tick(t0), { ok: false, skipped: 'dropped', pending: 3 });
  assert.equal(h.life.snapshot().droppedTotal, 1);
});

test('tick：白天额度用完 → daily-cap', async () => {
  const t0 = at(14);
  const h = makeLife({ state: { lastDay: dayOf(t0), firedToday: 6 } });
  assert.deepEqual(await h.life.tick(t0), { ok: false, skipped: 'daily-cap' });
  assert.equal(h.delivered.length, 0);
});

test('tick：maxPerDay<=0 不设每日额度（OPEN-CAP）', async () => {
  const t0 = at(14);
  const h = makeLife({ maxPerDay: 0, state: { lastDay: dayOf(t0), firedToday: 6 } });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true);
  assert.equal(h.life.snapshot().firedToday, 7, '继续累加但不拦');
});

test('tick：跨天计数归零后再判额度', async () => {
  const t0 = at(14);
  const h = makeLife({ maxPerDay: 6, state: { lastDay: '2000-01-01', firedToday: 6 } });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true);
  assert.equal(h.life.snapshot().firedToday, 1);
  assert.equal(h.life.snapshot().lastDay, dayOf(t0));
});

test('tick：没到点就不投（间隔抖动下界之外才到点）', async () => {
  const t0 = at(14);
  const justFired = makeLife({ state: { lastDay: dayOf(t0), lastFiredAt: t0 - 5 * 60000 } });
  assert.deepEqual(await justFired.life.tick(t0), { ok: false, skipped: 'not-yet' });

  const futureDue = makeLife({ state: { lastDay: dayOf(t0), lastFiredAt: t0 - 5 * 60000, dueAt: t0 + HOUR } });
  assert.deepEqual(await futureDue.life.tick(t0), { ok: false, skipped: 'not-yet' });
});

test('tick：到点（lastFiredAt 早于一个完整间隔）就投', async () => {
  const t0 = at(14);
  const h = makeLife({ state: { lastDay: dayOf(t0), lastFiredAt: t0 - 2 * HOUR } });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'day');
  assert.equal(h.life.snapshot().lastFiredAt, t0);
  assert.equal(h.life.snapshot().dueAt, 0, '投递成功清掉到点标记（否则每 tick 连发）');
});

// ───────────────────────── 半夜槽位 ─────────────────────────

test('tick：半夜槽位优先于额度（白天地满也给），且不占白天计数', async () => {
  const t0 = at(23, 40);
  const h = makeLife({ state: { lastDay: dayOf(t0), firedToday: 6, lastMidnightDay: '' } });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'midnight');
  assert.deepEqual(h.delivered, [DEFAULT_TEXT_MIDNIGHT]);
  const snap = h.life.snapshot();
  assert.equal(snap.firedToday, 6, '半夜不占白天额度');
  assert.equal(snap.lastMidnightDay, dayOf(t0));
});

test('tick：半夜犯困跳过；当天已经给过半夜也不再给', async () => {
  const t0 = at(23, 40);
  const drowsy = makeLife({ getLifeGate: () => 'drowsy', state: { lastDay: dayOf(t0), firedToday: 6 } });
  assert.deepEqual(await drowsy.life.tick(t0), { ok: false, skipped: 'daily-cap' }, '犯困跳过半夜后落到额度判定');
  assert.equal(drowsy.delivered.length, 0);

  const already = makeLife({ state: { lastDay: dayOf(t0), firedToday: 0, lastMidnightDay: dayOf(t0) } });
  const r = await already.life.tick(t0);
  assert.equal(r.kind, 'day', '半夜槽位用过 → 走普通白天的路');
});

test('tick：半夜槽位时间点前不触发', async () => {
  const t0 = at(23, 29);
  const h = makeLife({ state: { lastDay: dayOf(t0), firedToday: 0 } });
  const r = await h.life.tick(t0);
  assert.equal(r.kind, 'day');
  assert.deepEqual(h.delivered, [DEFAULT_TEXT_DAY]);
});

test('tick：自定义半夜时间（22:30）在 22:40 生效', async () => {
  const t0 = at(22, 40);
  const h = makeLife({ midnightAt: '22:30', state: { lastDay: dayOf(t0), firedToday: 0 } });
  const r = await h.life.tick(t0);
  assert.equal(r.kind, 'midnight');
});

// [回归] 曾经的真实 bug（own-life.js pastMidnightSlot）：`mh || 23` / `mm || 30` 把合法的
// 0 点/0 分当成「没配」——midnightAt="23:00" 实际排到 23:30，midnightAt="00:00" 排到 23:30。
// 2026-11-03 00:11 已由并发修改改为 `Number.isFinite` + 夹取（[TIME-ZERO]）。这两个用例锁住修复。
test('tick 半夜槽位：midnightAt="23:00" 的 0 分钟不能被默认值吞成 23:30', async () => {
  const t0 = at(23, 10);
  const h = makeLife({ midnightAt: '23:00', state: { lastDay: dayOf(t0), firedToday: 0 } });
  const r = await h.life.tick(t0);
  assert.equal(r.kind, 'midnight', '配置 23:00 时 23:10 已经过了半夜槽位，应进入半夜分支');
});

test('tick 半夜槽位：midnightAt="00:00" 的 0 点不能被吞成 23 点', async () => {
  const t0 = at(0, 5);
  const h = makeLife({ midnightAt: '00:00', state: { lastDay: dayOf(t0), firedToday: 0 } });
  const r = await h.life.tick(t0);
  assert.equal(r.kind, 'midnight', '配置 00:00 时 00:05 已经在槽位之后');
});

// ───────────────────────── 饥饿保底 ─────────────────────────

test('tick：饿过 3 个间隔且今天没给够 → 跳过「正忙」让路并记日志', async () => {
  const t0 = at(14);
  const h = makeLife({
    getLifeGate: () => 'in-progress',
    minPerDay: 2,
    state: { lastDay: dayOf(t0), firedToday: 0, lastFiredAt: t0 - 2 * HOUR, dueAt: t0 - 31 * 60000 },
  });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true, 'starved 时不再拿「她正在动手」当死门');
  assert.equal(h.life.snapshot().firedToday, 1);
  assert.ok(h.logs.some((l) => l.includes('今天还没给到自己的时间（已 0/2 次），这次跳过「正忙」让路')));
});

test('tick：饥饿让路日志 30 分钟内不重复刷', async () => {
  const t0 = at(14);
  const h = makeLife({
    getLifeGate: () => 'in-progress',
    minPerDay: 2,
    state: { lastDay: dayOf(t0), firedToday: 0, lastFiredAt: t0 - 2 * HOUR, dueAt: t0 - 31 * 60000, lastStarveLogAt: t0 - 1000 },
  });
  const r = await h.life.tick(t0);
  assert.equal(r.ok, true);
  assert.equal(h.logs.filter((l) => l.includes('跳过「正忙」让路')).length, 0);
});

test('tick：还没饿够（未满 30 分钟）时 in-progress 仍然推延', async () => {
  const t0 = at(14);
  const h = makeLife({
    getLifeGate: () => 'in-progress',
    minPerDay: 2,
    state: { lastDay: dayOf(t0), firedToday: 0, lastFiredAt: t0 - 20 * 60000, dueAt: t0 - 10 * 60000 },
  });
  const r = await h.life.tick(t0);
  assert.deepEqual(r, { ok: false, skipped: 'deferred', deferred: 0 });
  assert.ok(h.logs.some((l) => l.includes('往后推延（她正在动手，已积压 0/2 轮）')));
});

test('tick：minPerDay=0 不设饥饿保底，in-progress 照常推延', async () => {
  const t0 = at(14);
  const h = makeLife({
    getLifeGate: () => 'in-progress',
    minPerDay: 0,
    state: { lastDay: dayOf(t0), firedToday: 0, lastFiredAt: t0 - 2 * HOUR, dueAt: t0 - 31 * 60000 },
  });
  const r = await h.life.tick(t0);
  assert.equal(r.skipped, 'deferred');
});

// ───────────────────────── 落盘失败 ─────────────────────────

test('状态写不进去：只记日志，投递本身照常成功', async () => {
  const blocker = path.join(tmpRoot, 'blocker-file');
  fs.writeFileSync(blocker, 'not-a-dir', 'utf8');
  const logs = [];
  const delivered = [];
  const life = createOwnLife({
    key: 'private:1',
    deliver: async (t) => { delivered.push(t); },
    statePath: path.join(blocker, 'own-life.json'),
    log: (...a) => logs.push(a.join(' ')),
  });
  const r = await life.fireNow();
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
  assert.ok(logs.some((l) => l.includes('状态写不进去（忽略）')), `实际日志：${JSON.stringify(logs)}`);
});

// ───────────────────────── 她自己调的节奏（rhythmPath）─────────────────────────

test('rhythm：状态文件的间隔/安静窗覆盖系统默认', () => {
  const rhythmPath = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(rhythmPath, { intervalMs: 30 * 60000, quiet: [10, 12] });
  const h = makeLife({ rhythmPath });
  const snap = h.life.snapshot().rhythm;
  assert.equal(snap.intervalMs, 30 * 60000);
  assert.deepEqual(snap.quiet, [10, 12]);
});

test('rhythm：间隔被夹在 30 分钟 ~ 12 小时', () => {
  const fast = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(fast, { intervalMs: 1000 });
  assert.equal(makeLife({ rhythmPath: fast }).life.snapshot().rhythm.intervalMs, 30 * 60000);

  const slow = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(slow, { intervalMs: 99 * HOUR });
  assert.equal(makeLife({ rhythmPath: slow }).life.snapshot().rhythm.intervalMs, 12 * HOUR);
});

test('rhythm：安静窗夹到 0~24，非法值回落到系统默认', () => {
  const clamped = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(clamped, { quiet: [-5, 99] });
  assert.deepEqual(makeLife({ rhythmPath: clamped }).life.snapshot().rhythm.quiet, [0, 24]);

  const malformed = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(malformed, { quiet: ['a', 'b'] });
  assert.deepEqual(makeLife({ rhythmPath: malformed }).life.snapshot().rhythm.quiet, [3, 8]);

  const shortList = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(shortList, { quiet: [10] });
  assert.deepEqual(makeLife({ rhythmPath: shortList }).life.snapshot().rhythm.quiet, [3, 8]);

  const broken = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(broken, '{坏 JSON');
  const snap = makeLife({ rhythmPath: broken }).life.snapshot().rhythm;
  assert.equal(snap.intervalMs, HOUR);
  assert.deepEqual(snap.quiet, [3, 8]);
});

test('rhythm：每 60 秒热读一次（改了不用重启，但不会每跳都读盘）', async () => {
  const t0 = at(4); // 凌晨 4 点：用来区分两个安静窗
  const rhythmPath = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(rhythmPath, { intervalMs: HOUR, quiet: [10, 12] });
  const h = makeLife({ rhythmPath, state: { lastDay: dayOf(t0), dueAt: t0 + HOUR } });

  assert.deepEqual(await h.life.tick(t0), { ok: false, skipped: 'not-yet' }, 'quiet=[10,12]：4 点不安静');
  rhythmFile(rhythmPath, { intervalMs: HOUR, quiet: [3, 8] });
  assert.deepEqual(await h.life.tick(t0 + 30_000), { ok: false, skipped: 'not-yet' }, '60 秒缓存内仍用旧节奏');
  assert.deepEqual(await h.life.tick(t0 + 61_000), { ok: false, skipped: 'quiet' }, '缓存过期后读到新安静窗');
});

test('rhythm：安静窗覆盖后 tick 真的按她的节奏安静', async () => {
  const rhythmPath = path.join(tmpRoot, `rhythm-${++seq}.json`);
  rhythmFile(rhythmPath, { intervalMs: HOUR, quiet: [14, 16] });
  const h = makeLife({ rhythmPath });
  assert.deepEqual(await h.life.tick(at(14, 30)), { ok: false, skipped: 'quiet' });
});

// ───────────────────────── 生命周期 ─────────────────────────

test('start/stop：只武装一次、日志说清节奏、stop 可重复调用', () => {
  const h = makeLife({ maxPerDay: 0 });
  h.life.start();
  h.life.start();
  assert.equal(h.logs.filter((l) => l.includes('已武装')).length, 1, '重复 start 不叠加定时器');
  const armed = h.logs.find((l) => l.includes('已武装'));
  assert.ok(armed.includes('每 1.0h 一次'));
  assert.ok(armed.includes('安静时段 3:00–8:00'));
  assert.ok(armed.includes('半夜 23:30'));
  assert.ok(armed.includes('不设每日额度'));

  h.life.stop();
  h.life.stop();
  assert.equal(h.logs.filter((l) => l.includes('已停止')).length, 2);
});

test('start：有额度时日志写明每天最多几次', () => {
  const h = makeLife({ maxPerDay: 4 });
  h.life.start();
  assert.ok(h.logs.some((l) => l.includes('每天最多 4 次')));
  h.life.stop();
});
