// inori-curiosity 金标：挂心事的容器语义——不任务化、14 天自然沉底、重复只刷新时间、渲染只给许可。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, forget, openLoops, renderLine, stats } from '../src/domain/leaves/inori-curiosity.js';

const DAY = 24 * 3600000;
const NOW = 1_800_000_000_000;

test('record：挂上一件事，最新在前；空文本不挂', () => {
  let s = record(null, { text: '第一件', source: '群聊' }, NOW - 1000);
  s = record(s, { text: '第二件' }, NOW);
  assert.deepEqual(s.loops.map((l) => l.text), ['第二件', '第一件']);
  assert.equal(s.loops[1].source, '群聊');
  const same = record(s, { text: '   ' }, NOW);
  assert.equal(same.loops.length, 2, '空文本不新增');
});

test('record：同一件事再提只刷新时间戳，不加一条', () => {
  let s = record(null, { text: '想弄清 bge-m3', source: '群聊' }, NOW - 10 * DAY);
  const before = s.loops[0].ts;
  s = record(s, { text: ' 想弄清   bge-m3 ' }, NOW);
  assert.equal(s.loops.length, 1, '空白差异也算同一件');
  assert.ok(s.loops[0].ts > before);
});

test('record：超过 14 天的自动沉底（从 loops 里清掉）', () => {
  let s = record(null, { text: '老了的事' }, NOW - 15 * DAY);
  s = record(s, { text: '新事' }, NOW);
  assert.deepEqual(s.loops.map((l) => l.text), ['新事'], '15 天前的记录被清');
});

test('openLoops：只给 14 天内、最多 4 件、最新在前', () => {
  let s = { loops: [] };
  for (let i = 0; i < 6; i += 1) s = record(s, { text: `事${i}` }, NOW - i * 1000);
  const open = openLoops(s, NOW);
  assert.equal(open.length, 4);
  assert.deepEqual(open.map((l) => l.text), ['事0', '事1', '事2', '事3']);
});

test('forget：整条匹配或包含匹配都放下', () => {
  let s = record(null, { text: '想弄明白 bge-m3 怎么用' }, NOW);
  s = forget(s, 'bge-m3');
  assert.equal(s.loops.length, 0, '包含匹配就能放下');

  let t = record(null, { text: '完全一致' }, NOW);
  t = forget(t, '完全一致');
  assert.equal(t.loops.length, 0);
  assert.equal(forget(t, '').loops.length, 0, '空匹配不误删（已经空了）');
});

test('forget：空匹配不该把全部删掉', () => {
  const s = record(null, { text: '保留我' }, NOW);
  const after = forget(s, '   ');
  assert.equal(after.loops.length, 1);
});

test('renderLine：空容器返回 null（不制造「你该做点什么」的暗示）', () => {
  assert.equal(renderLine({ loops: [] }, NOW), null);
  assert.equal(renderLine(null, NOW), null);
});

test('renderLine：只给事实+许可；挂心 2 天以上才提天数', () => {
  const s = record(null, { text: '想看看那个视频', source: '群聊' }, NOW - 3 * DAY);
  const line = renderLine(s, NOW);
  assert.ok(line.includes('你挂心着的事'));
  assert.ok(line.includes('想接就哪天顺手接了'), '许可语气');
  assert.ok(!line.includes('应该'), '不许写「应该」');
  assert.ok(line.includes('挂心 3 天了'));
  const fresh = renderLine(record(null, { text: '今天才挂的' }, NOW), NOW);
  assert.ok(!fresh.includes('挂心 0 天了'), '当天不啰嗦天数');
});

test('stats：分开数「还开着」与「已沉底」', () => {
  const s = { loops: [{ text: 'a', ts: NOW - 1 * DAY }, { text: 'b', ts: NOW - 20 * DAY }] };
  assert.deepEqual(stats(s, NOW), { open: 1, settled: 1 });
});
