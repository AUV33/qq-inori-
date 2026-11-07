// [ACQ-GATE / TRACK-SPLIT / JUDGMENT-ONLY] 2026-10-31 学习分轨回归锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBrowseEntry, markBrowseOutcome, pendingBrowse } from '../src/domain/leaves/inori-browse.js';
import { add as addLesson, selectForContext } from '../src/domain/leaves/inori-lessons.js';
import { add as addCognition } from '../src/domain/leaves/inori-cognition.js';

test('空的浏览结果只记 missed，不标 sedimented', () => {
  const empty = newBrowseEntry({ at: 1, tool: 'web_search', arg: '空', head: '' });
  const full = newBrowseEntry({ at: 2, tool: 'web_search', arg: '有', head: '有内容' });
  const r = markBrowseOutcome({ entries: [empty, full] }, [empty, full]);
  assert.equal(r.sedimented, 1);
  assert.equal(r.missed, 1);
  assert.equal(r.store.entries[0].sedimentedAt, undefined);
  assert.ok(r.store.entries[0].missedAt);
  assert.ok(r.store.entries[1].sedimentedAt);
  assert.equal(pendingBrowse(r.store).length, 0);
});

test('判断轨没有反例就不收；做法轨可收', () => {
  const list = [];
  const noCounter = addLesson(list, '他一冷场我就先接梗', { kind: 'about-him', track: 'reading', requireCounterexample: true });
  assert.equal(noCounter.ok, false);
  assert.equal(noCounter.reason, 'counterexample-required');
  const ok = addLesson(list, '他一冷场我就先接梗', { kind: 'about-him', track: 'reading', counterexample: '他明显想安静时别接' });
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.track, 'reading');
  const doing = addLesson(list, '手机锁屏先按电源键再截屏', { kind: 'about-me' });
  assert.equal(doing.entry.track, 'doing');
});

test('判断轨与做法轨按上下文分开注入', () => {
  const list = [];
  addLesson(list, '他一冷场我就先接梗', { kind: 'about-him', track: 'reading', counterexample: '他想安静时别接' });
  addLesson(list, '手机锁屏先按电源键再截屏', { kind: 'about-me', track: 'doing' });
  const reading = selectForContext(list, '手机锁屏了', { tracks: ['reading'] });
  assert.equal(reading.selected.length, 1);
  assert.equal(reading.selected[0].track, 'reading');
  const doing = selectForContext(list, '手机锁屏了', { tracks: ['doing'] });
  assert.equal(doing.selected.length, 1);
  assert.equal(doing.selected[0].track, 'doing');
});

test('认知拒收 how-to 和没有 when 的条目', () => {
  assert.equal(addCognition([], { concept: '先点 A 再点 B', kind: 'how-to', when: '任何时候' }).ok, false);
  assert.equal(addCognition([], { concept: '他是嘴硬', kind: 'about-him', when: '', requireWhen: true }).ok, false);
});

test('同一主体更新同一条；supersedes 让旧条失效', () => {
  const first = addCognition([], { concept: '他怕落笔', gist: '先推他写', kind: 'about-him', when: '他不敢写的时候', requireWhen: true });
  assert.equal(first.ok, true);
  assert.equal(first.entry.subject, '他怕落笔');
  const second = addCognition(first.items, { concept: '他怕落笔', gist: '先推他写，别替他圆', kind: 'about-him', when: '他不敢写的时候', requireWhen: true });
  assert.equal(second.updated, true);
  assert.equal(second.items.length, 1);
  const third = addCognition(second.items, { concept: '他怕落笔', gist: '先推他写，写空也算', kind: 'about-him', when: '他不敢写的时候', supersedes: first.entry.id, requireWhen: true });
  assert.equal(third.ok, true);
  assert.equal(third.items.length, 2);
  assert.ok(third.items.find((x) => x.id === first.entry.id).invalidAt);
});
