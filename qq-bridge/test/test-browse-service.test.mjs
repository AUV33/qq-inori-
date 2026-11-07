// browse-service 金标：空内容只记 missed、≥2 条才沉淀、同文不重复写、失败不外抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseService } from '../src/domain/send/browse-service.mjs';

function makeCtx(pending = [], overrides = {}) {
  const state = {
    store: { pending: [...pending] },
    saved: 0,
    appended: [],
    missedMarked: 0,
    sedimented: 0,
  };
  const svc = createBrowseService({
    log: () => {},
    getBrowseStore: () => state.store,
    setBrowseStore: (v) => { state.store = v; },
    browseSave: () => { state.saved += 1; },
    pendingBrowse: (store) => (store.pending ?? []),
    hasContent: (e) => Boolean(e && e.title && e.url && e.summary !== ''),
    markBrowseOutcome: (store, list, at) => {
      if (list.length && list.every((e) => !e.title)) state.missedMarked += list.length;
      else state.sedimented += list.length;
      const done = new Set(list.map((e) => e.url));
      return { store: { ...store, pending: store.pending.filter((e) => !done.has(e.url)) }, missed: state.missedMarked, sedimented: state.sedimented };
    },
    renderBrowseDigest: (list) => (list.length ? list.map((e) => `${e.title}：${e.summary}`).join('\n') : ''),
    loadEntries: () => [],
    MEMORY_FILE: 'memory.jsonl',
    appendJsonl: (file, row) => state.appended.push({ file, row }),
    ...overrides,
  });
  return { svc, state };
}

const withContent = (n) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, url: `https://e/${i}`, summary: 's' }));
const empty = (n) => Array.from({ length: n }, (_, i) => ({ title: '', url: `https://empty/${i}`, summary: '' }));

test('没有 pending → 什么都不做', () => {
  const h = makeCtx();
  h.svc.sedimentBrowseIfAny();
  assert.equal(h.state.appended.length, 0);
  assert.equal(h.state.saved, 0);
});

test('只有空 head：记 missed，不写记忆', () => {
  const h = makeCtx([...empty(2), ...withContent(1)]);
  h.svc.sedimentBrowseIfAny();
  assert.equal(h.state.missedMarked, 2);
  assert.equal(h.state.appended.length, 0, '1 条有内容不够沉淀阈值');
  assert.ok(h.state.saved >= 1);
});

test('≥2 条有内容 → 写一条 browse 记忆并标已处理', () => {
  const h = makeCtx([...withContent(2), ...empty(1)]);
  h.svc.sedimentBrowseIfAny();
  assert.equal(h.state.appended.length, 1);
  const row = h.state.appended[0].row;
  assert.equal(row.kind, 'browse');
  assert.equal(row.src, 'auto');
  assert.equal(row.importance, 2);
  assert.ok(row.text.includes('t0'));
  assert.equal(h.state.store.pending.length, 0, '处理过的都不该留在 pending');
});

test('同一段浏览文本已存在 → 跳过写入，但仍然标已处理（不留死 pending）', () => {
  const h = makeCtx([...withContent(3)], {
    loadEntries: () => [{ text: 't0：s\nt1：s\nt2：s' }],
  });
  h.svc.sedimentBrowseIfAny();
  assert.equal(h.state.appended.length, 0, '同文不重复写');
  assert.equal(h.state.store.pending.length, 0);
});

test('appendJsonl 抛错不把异常甩给调用方', () => {
  const h = makeCtx([...withContent(2)], {
    appendJsonl: () => { throw new Error('磁盘满'); },
  });
  assert.doesNotThrow(() => h.svc.sedimentBrowseIfAny());
});
