// inori-wish 金标：愿望归她——系统只记得住/到点叫/记已交付，不催不替她做。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordWish, doneWish, openWishes, dueWishes, markRun, renderWishLine } from '../src/domain/leaves/inori-wish.js';

const NOW = 1_800_000_000_000;
const MIN = 60000;
const DAY = 86400000;

test('recordWish：记一件想干的事，带排期；空愿望不记', () => {
  const s = recordWish(null, { wish: '去群里说句话', key: 'group:1', inMinutes: 30, source: '聊到一半' }, NOW);
  assert.equal(s.items.length, 1);
  const w = s.items[0];
  assert.equal(w.wish, '去群里说句话');
  assert.equal(w.key, 'group:1');
  assert.equal(w.runAt, NOW + 30 * MIN);
  assert.equal(w.source, '聊到一半');
  assert.equal(w.done, false);
  assert.ok(w.id);

  assert.equal(recordWish(null, { wish: '   ' }, NOW).items.length, 0);
});

test('recordWish：同愿望同会话刷新排期而不是加一条；不同会话算两件', () => {
  let s = recordWish(null, { wish: '去群里说话', key: 'group:1', inMinutes: 60 }, NOW);
  s = recordWish(s, { wish: ' 去群里说话 ', key: 'group:1', inMinutes: 5 }, NOW + MIN);
  assert.equal(s.items.length, 1, '空白差异也算同一件');
  assert.equal(s.items[0].runAt, NOW + MIN + 5 * MIN, '排期被刷新');

  s = recordWish(s, { wish: '去群里说话', key: 'group:2' }, NOW + 2 * MIN);
  assert.equal(s.items.length, 2, '换会话算另一件');
});

test('recordWish：inMinutes 被夹在 0..7 天；inMinutes=0 表示尽快', () => {
  const soon = recordWish(null, { wish: '马上', inMinutes: 0 }, NOW);
  assert.equal(soon.items[0].runAt, NOW);
  const capped = recordWish(null, { wish: '很久以后', inMinutes: 999999 }, NOW);
  assert.equal(capped.items[0].runAt, NOW + 7 * DAY);
});

test('recordWish：超过 14 天的旧愿望沉底；总量有界（12*2）', () => {
  let s = { items: [{ id: 'old', wish: '很久以前', key: '', at: NOW - 15 * DAY, runAt: 0, done: false }] };
  s = recordWish(s, { wish: '新的', inMinutes: 0 }, NOW);
  assert.equal(s.items.some((x) => x.id === 'old'), false);

  for (let i = 0; i < 40; i += 1) s = recordWish(s, { wish: `愿望${i}` }, NOW + i);
  assert.ok(s.items.length <= 24, `有界，实际 ${s.items.length}`);
});

test('doneWish：整条或前缀包含都关闭，并记完成时间', () => {
  let s = recordWish(null, { wish: '把群记忆整理好', key: 'group:1' }, NOW);
  s = doneWish(s, '群记忆', NOW + 1000);
  assert.equal(s.items[0].done, true);
  assert.equal(s.items[0].doneAt, NOW + 1000);
  assert.equal(openWishes(s, NOW + 2000).length, 0, '关闭后不再算挂着');
});

test('openWishes：只给 14 天内未关闭的，最多 4 件，最新在前', () => {
  let s = { items: [] };
  for (let i = 0; i < 6; i += 1) s = recordWish(s, { wish: `愿望${i}` }, NOW + i);
  const open = openWishes(s, NOW + 10);
  assert.equal(open.length, 4);
  assert.deepEqual(open.map((w) => w.wish), ['愿望5', '愿望4', '愿望3', '愿望2']);
});

test('dueWishes：到点且未关闭才叫；runAt=0 的只挂着', () => {
  let s = recordWish(null, { wish: '到点了', key: 'group:1', inMinutes: 10 }, NOW);
  s = recordWish(s, { wish: '没排期', key: 'group:1', inMinutes: 0 }, NOW);
  const due = dueWishes(s, NOW + 11 * MIN);
  assert.deepEqual(due.map((w) => w.wish).sort(), ['到点了', '没排期'].sort(), 'inMinutes=0 的 runAt=now，到点即 due');

  assert.equal(dueWishes(s, NOW + 5 * MIN).some((w) => w.wish === '到点了'), false, '没到点不叫');
});

test('markRun：交付后 runAt 归零（不重复叫醒），愿望仍挂着', () => {
  let s = recordWish(null, { wish: '叫一次就好', key: 'group:1', inMinutes: 5 }, NOW);
  const id = s.items[0].id;
  s = markRun(s, [id], NOW + 6 * MIN);
  assert.equal(s.items[0].runAt, 0);
  assert.equal(dueWishes(s, NOW + 60 * MIN).length, 0, '不再到点');
  assert.equal(openWishes(s, NOW + 60 * MIN).length, 1, '但仍挂在容器里等她关掉');
});

test('renderWishLine：空容器返回 null；有内容时只给事实+许可', () => {
  assert.equal(renderWishLine({ items: [] }, NOW), null);
  assert.equal(renderWishLine(null, NOW), null);

  let s = recordWish(null, { wish: '去群里说句话', key: 'group:1', inMinutes: 30, source: '聊到一半' }, NOW);
  const line = renderWishLine(s, NOW);
  assert.ok(line.includes('你想自己干的事（不催：想做就做'));
  assert.ok(line.includes('约 30 分钟后到点'));
  assert.ok(line.includes('（来自聊到一半）'));
  assert.ok(line.includes('qq_wish done'), '告诉她关掉的入口，但不命令');
  assert.ok(!/应该|挑一件/.test(line));
});

test('renderWishLine：没排期的显示「在等空档」', () => {
  const s = { items: [{ id: 'a', wish: '随便写点', key: '', at: NOW, runAt: 0, done: false }] };
  assert.ok(renderWishLine(s, NOW).includes('（在等空档）'));
});
