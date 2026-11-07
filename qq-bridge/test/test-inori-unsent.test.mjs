// inori-unsent 金标：挂心事容器的纪律——只收短句、同文不重复、短句优先、14 天沉没。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ITEMS, SINK_TTL_MS, RENDER_LIMIT, SINK_AFTER_MS, MAX_SINK_CHARS,
  takeExpiredHint, compareUnsent, sinkUnsent, renderUnsentLine,
} from '../src/domain/leaves/inori-unsent.js';

const NOW = 1_800_000_000_000;
const DAY = 86400000;

test('takeExpiredHint：只有超过 10 分钟且带时间戳的才沉底', () => {
  assert.deepEqual(takeExpiredHint({ text: '好', at: NOW - SINK_AFTER_MS - 1 }, NOW), { text: '好', at: NOW - SINK_AFTER_MS - 1 });
  assert.equal(takeExpiredHint({ text: '好', at: NOW - 1000 }, NOW), null, '没过期');
  assert.equal(takeExpiredHint({ text: '好' }, NOW), null, '没时间戳不敢断言过期');
  assert.equal(takeExpiredHint({ text: '  ', at: NOW - 999999 }, NOW), null);
  assert.equal(takeExpiredHint(null, NOW), null);
});

test('sinkUnsent：短句能沉；同文不重复；长句（旁白）不收', () => {
  const state = { items: [] };
  assert.equal(sinkUnsent(state, { text: '好', key: 'group:1' }, NOW), true);
  assert.equal(sinkUnsent(state, { text: '好', key: 'group:1' }, NOW + 1), false, '同文不重复沉');
  assert.equal(sinkUnsent(state, { text: '啊'.repeat(MAX_SINK_CHARS + 1) }, NOW), false, '长句几乎都是她写给自己的旁白');
  assert.equal(sinkUnsent(state, { text: '   ' }, NOW), false);
  assert.equal(sinkUnsent(null, { text: 'x' }, NOW), false);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].key, 'group:1');
  assert.equal(state.items[0].sinkAt, NOW);
});

test('sinkUnsent：超过 5 条时按「短句优先」淘汰（真漏发的短句不被旁白挤掉）', () => {
  const state = { items: [] };
  for (let i = 0; i < 6; i += 1) sinkUnsent(state, { text: `这是第${i}句比较长的旁白文字` }, NOW + i);
  sinkUnsent(state, { text: '好' }, NOW + 100);
  assert.equal(state.items.length, MAX_ITEMS);
  assert.ok(state.items.some((i) => i.text === '好'), '短句必须留下');
});

test('sinkUnsent：超过 14 天的条目被清掉', () => {
  const state = { items: [{ text: '很旧的一句', at: NOW - 20 * DAY, sinkAt: NOW - 20 * DAY }] };
  sinkUnsent(state, { text: '新的', at: NOW }, NOW);
  assert.deepEqual(state.items.map((i) => i.text), ['新的']);
});

test('compareUnsent：短句优先，同长度按沉的先后（新的在前）', () => {
  const a = { text: '短的', sinkAt: 1 };
  const b = { text: '更长的一句话', sinkAt: 2 };
  assert.ok(compareUnsent(a, b) < 0);
  const c = { text: '同长', sinkAt: 5 };
  const d = { text: '同长2', sinkAt: 9 };
  assert.ok(compareUnsent(c, d) < 0, '同长度时更新的排前面');
});

test('renderUnsentLine：空容器 null；有内容时最多两条、带许可', () => {
  assert.equal(renderUnsentLine({ items: [] }, NOW), null);
  assert.equal(renderUnsentLine(null, NOW), null);

  const state = { items: [] };
  for (const t of ['好', '嗯', '再说一句短的']) sinkUnsent(state, { text: t, key: 'group:1' }, NOW);
  const line = renderUnsentLine(state, NOW);
  assert.ok(line.includes('【没发出去的文字】'));
  assert.equal((line.match(/^- /gm) || []).length, RENDER_LIMIT);
  assert.ok(line.includes('（group:1）'));
  assert.ok(line.includes('本来就只是你自己记的、或者已经过去了，放着不用管'), '许可语气，不催');
});

test('renderUnsentLine：过期的条目不渲染', () => {
  const state = { items: [{ text: '很旧', sinkAt: NOW - SINK_TTL_MS - 1 }] };
  assert.equal(renderUnsentLine(state, NOW), null);
});

test('renderUnsentLine：旧数据里的长条目在展示位让给短句，最多两条', () => {
  const state = {
    items: [
      { text: '这是一条较长的历史条目，可能是旧版本沉进来的', key: 'group:1', sinkAt: NOW - 3000 },
      { text: '通了', key: 'private:2', sinkAt: NOW - 2000 },
      { text: '好', key: 'private:2', sinkAt: NOW - 1000 },
    ],
  };
  const line = renderUnsentLine(state, NOW);
  assert.ok(line.includes('「好」'), '最短的优先出现');
  assert.ok(line.includes('「通了」'), '第二短的一起出现');
  assert.ok(!line.includes('较长的历史条目'), '展示位只有 2 个');
  assert.ok(line.includes('private:2'), '标出在哪个会话');
});

test('sinkUnsent：容量满时最短的留下、最长的先走', () => {
  const state = { items: [] };
  const shorts = ['这是一句比较长的短句占位', '中等长度的一句话', '中等的话', '简短', '好'];
  for (const s of shorts) sinkUnsent(state, { text: s, key: 'g' }, NOW);
  assert.equal(state.items.length, MAX_ITEMS);
  sinkUnsent(state, { text: '在了', key: 'g' }, NOW + 100);
  assert.equal(state.items.length, MAX_ITEMS);
  assert.ok(state.items.some((i) => i.text === '在了'), '新来的短句留下');
  assert.ok(!state.items.some((i) => i.text === '这是一句比较长的短句占位'), '最长的一条被淘汰');
});

test('takeExpiredHint：at=0 视为没有时间戳（不敢断言过期）', () => {
  assert.equal(takeExpiredHint({ text: '好', at: 0 }, NOW), null);
});
