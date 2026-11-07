// inori-reflect 金标：反思触发的时间窗与冷却、提示词产出要求、产出对比（没有产出就是失败）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFLECT_GUIDE, DEFAULTS, shouldRun, buildPrompt, checkOutcome } from '../src/domain/leaves/inori-reflect.js';

const at = (h, extraMs = 0) => new Date(2026, 10, 2, h, 30, 0, extraMs);

test('shouldRun：只在 2:00–5:00 窗口内跑', () => {
  assert.equal(shouldRun(at(1), null).run, false);
  assert.match(shouldRun(at(1), null).reason, /outside-window\(1h\)/);
  assert.equal(shouldRun(at(2), null).run, true);
  assert.equal(shouldRun(at(4), null).run, true);
  assert.equal(shouldRun(at(5), null).run, false, '窗口右开');
  assert.equal(shouldRun(at(12), null).run, false);
});

test('shouldRun：20 小时冷却，防同一天重复跑', () => {
  const last = at(3).getTime();
  assert.equal(shouldRun(at(4), last).run, false);
  assert.match(shouldRun(at(4), last).reason, /cooldown/);
  const yesterday = last - 21 * 3600000;
  assert.equal(shouldRun(at(3), yesterday).run, true);
  assert.equal(shouldRun(at(3), null).reason, 'ok');
});

test('shouldRun：窗口/冷却都可覆盖', () => {
  assert.equal(shouldRun(at(10), null, { hourStart: 10, hourEnd: 11 }).run, true);
  assert.equal(shouldRun(at(3), at(2).getTime(), { cooldownHours: 0.5 }).run, true);
});

test('buildPrompt：带日期与统计，并把产出要求（min/max）替换进去', () => {
  const text = buildPrompt({ date: '2026-11-02', lessonCount: 12, recentCount: 40, memoryCount: 88 });
  assert.ok(text.startsWith('【夜间反思 · 2026-11-02】'));
  assert.ok(text.includes('现在你攒了 12 条经验'));
  assert.ok(text.includes('今天有过 40 条对话、88 条记忆'));
  assert.ok(!text.includes('{{minLessons}}'), '占位符要被替换');
  assert.ok(!text.includes('{{maxLessons}}'));
});

test('buildPrompt：缺失统计显示 0，不抛错', () => {
  const text = buildPrompt(undefined);
  assert.ok(text.includes('现在你攒了 0 条经验'));
  assert.ok(text.includes('今天有过 0 条对话、0 条记忆'));
});

test('DEFAULT_REFLECT_GUIDE：只做一件事、不凑数、最多一条、可以什么都不写', () => {
  const guide = DEFAULT_REFLECT_GUIDE;
  assert.ok(guide.includes('不用凑数'));
  assert.ok(guide.includes('最多一条'));
  assert.ok(guide.includes('没有：什么都别写'));
  assert.ok(guide.includes('不要为了完成反思硬写'));
});

test('checkOutcome：有产出才算成功；0 条就是失败（不能「叫过了就算」）', () => {
  assert.deepEqual(checkOutcome(10, 11), { ok: true, added: 1, reason: 'enough' });
  assert.deepEqual(checkOutcome(10, 10), { ok: false, added: 0, reason: 'no-turn', settled: false });
  assert.deepEqual(checkOutcome(10, 9), { ok: false, added: 0, reason: 'no-turn', settled: false }, '条数变少也算没有新增');
});

test('checkOutcome 三分类：想了但没写工具 → thought-only（收工、不重试、不虚报）', () => {
  const t = { kind: 'completed', len: 238, head: '今天他说想改名，我没接话…', sessionId: 's-reflect-1' };
  const r = checkOutcome(10, 10, { thought: t, sessionId: 's-reflect-1' });
  assert.equal(r.reason, 'thought-only');
  assert.equal(r.settled, true, '已想明白，不该重试到今夜用尽');
  assert.equal(r.ok, false, '没写 lesson 就不能虚报达标');
  assert.equal(r.thought.head, t.head);
  assert.equal(r.thought.sessionId, 's-reflect-1');
});

test('checkOutcome：别的会话的旧 thought 不能冒充本轮（防串台）', () => {
  const stale = { kind: 'completed', len: 500, head: '上一次独处时想的', sessionId: 's-ownlife-9' };
  const r = checkOutcome(10, 10, { thought: stale, sessionId: 's-reflect-1' });
  assert.equal(r.reason, 'no-turn');
  assert.equal(r.settled, false);
});

test('checkOutcome：思考文本为空 / 回合未完成 → no-turn', () => {
  assert.equal(checkOutcome(10, 10, { thought: { kind: 'completed', len: 0, head: '' } }).reason, 'no-turn');
  assert.equal(checkOutcome(10, 10, { thought: { kind: 'blocked', len: 200, head: 'x' } }).reason, 'no-turn');
  assert.equal(checkOutcome(10, 10, { thought: null }).reason, 'no-turn');
});

test('checkOutcome：minLessons>0 时不足算 partial', () => {
  const r = checkOutcome(0, 1, { minLessons: 2 });
  assert.deepEqual(r, { ok: false, added: 1, reason: 'partial(1<2)' });
  assert.equal(DEFAULTS.maxLessons, 1, '默认最多一条判断');
});
