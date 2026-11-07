// inori-interest 金标：「遇到」驱动的兴趣——只记事实+给许可，不评价、不催、不产任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLikes, recordEncounter, openEncounters, renderEncounterLine } from '../src/domain/leaves/inori-interest.js';

const NOW = 1_800_000_000_000;
const DAY = 86400000;

test('detectLikes：认出「喜欢/被戳中」的表达并截出片段', () => {
  const hit = detectLikes('这个游戏好可爱，我想玩');
  assert.ok(hit);
  assert.equal(hit.phrase, '好可爱');
  assert.ok(hit.snippet.includes('好可爱'));

  const likes = detectLikes('这首好听！绝了');
  assert.equal(likes.phrase, '好听');
});

test('detectLikes：普通陈述/空文本不误判', () => {
  assert.equal(detectLikes('今天吃了面'), null);
  assert.equal(detectLikes(''), null);
  assert.equal(detectLikes(null), null);
});

test('recordEncounter：unknown/like 分开存，最新在前；重复只刷新时间', () => {
  let s = recordEncounter(null, { kind: 'unknown', what: 'bge-m3', src: '群聊' }, NOW - 1000);
  s = recordEncounter(s, { kind: 'like', what: '那个视频' }, NOW);
  assert.deepEqual(s.items.map((x) => `${x.kind}:${x.what}`), ['like:那个视频', 'unknown:bge-m3']);

  const before = s.items[1].at;
  s = recordEncounter(s, { kind: 'unknown', what: ' bge-m3 ' }, NOW + 1000);
  assert.equal(s.items.filter((x) => x.what === 'bge-m3').length, 1, '同 kind 同内容不重复');
  assert.ok(s.items.find((x) => x.what === 'bge-m3').at > before);
});

test('recordEncounter：kind 非法按 unknown；空 what 不记；过期条目清理', () => {
  let s = recordEncounter(null, { kind: '随便', what: 'x' }, NOW);
  assert.equal(s.items[0].kind, 'unknown');
  s = recordEncounter(s, { what: '   ' }, NOW);
  assert.equal(s.items.length, 1, '空内容不记');

  s = recordEncounter(s, { kind: 'like', what: '别的' }, NOW + 8 * DAY);
  assert.equal(s.items.some((x) => x.what === 'x'), false, '超过 7 天清掉');
});

test('openEncounters：只给 24h 内的，unknown 最多 3 条、like 最多 2 条', () => {
  let s = { items: [] };
  for (let i = 0; i < 5; i += 1) s = recordEncounter(s, { kind: 'unknown', what: `词${i}` }, NOW - i * 1000);
  for (let i = 0; i < 4; i += 1) s = recordEncounter(s, { kind: 'like', what: `喜欢${i}` }, NOW - i * 1000);
  s = recordEncounter(s, { kind: 'like', what: '昨天以前的' }, NOW - 2 * DAY);

  const open = openEncounters(s, NOW);
  assert.equal(open.unknown.length, 3);
  assert.equal(open.like.length, 2);
  assert.equal(open.like.some((x) => x.what === '昨天以前的'), false);
});

test('renderEncounterLine：只给事实+许可；空容器返回 null', () => {
  assert.equal(renderEncounterLine({ items: [] }, NOW), null);
  assert.equal(renderEncounterLine(null, NOW), null);

  let s = recordEncounter(null, { kind: 'unknown', what: 'bge-m3', src: '群聊' }, NOW);
  s = recordEncounter(s, { kind: 'like', what: '那个视频' }, NOW);
  const line = renderEncounterLine(s, NOW);
  assert.ok(line.startsWith('【你遇到的东西】'));
  assert.ok(line.includes('心里痒就去弄明白，不痒就放着'));
  assert.ok(line.includes('想再看就再看，不想就算'));
  assert.ok(!/应该|必须|任务/.test(line), '不许写成任务单');
});
