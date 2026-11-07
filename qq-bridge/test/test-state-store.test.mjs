import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../src/domain/shared/state-store.mjs';

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  return createStateStore({ root });
}

test('writeJson/readJson：往返、建目录、不留 tmp', async () => {
  const store = tmpStore();
  await store.writeJson('mind/self.json', { energy: 0.5 });
  assert.deepEqual(store.readJson('mind/self.json'), { energy: 0.5 });
  const files = fs.readdirSync(path.join(store.root, 'mind'));
  assert.deepEqual(files, ['self.json']);
});

test('readJson：缺失或损坏返回 fallback', () => {
  const store = tmpStore();
  assert.equal(store.readJson('nope.json', { ok: true }).ok, true);
  fs.mkdirSync(path.join(store.root, 'x'), { recursive: true });
  fs.writeFileSync(path.join(store.root, 'x/bad.json'), '{bad');
  assert.equal(store.readJson('x/bad.json', null), null);
});

test('路径越界被拒绝', () => {
  const store = tmpStore();
  assert.throws(() => store.writeJson('../escape.json', {}), /traversal|outside/);
  assert.throws(() => store.writeJson('C:/x.json', {}), /absolute/);
});

test('validate 失败不落盘', async () => {
  const store = tmpStore();
  await assert.rejects(() => store.writeJson('a.json', { bad: true }, {
    validate: (value) => { if (value.bad) throw new Error('bad shape'); },
  }), /bad shape/);
  assert.equal(store.exists('a.json'), false);
});

test('updateJson：并发读改写不丢更新', async () => {
  const store = tmpStore();
  await store.writeJson('counter.json', { n: 0 });
  await Promise.all(Array.from({ length: 50 }, () => store.updateJson('counter.json', (cur) => ({ n: (cur?.n || 0) + 1 }))));
  assert.equal(store.readJson('counter.json').n, 50);
});

test('appendJsonl/readJsonl：追加与容错', async () => {
  const store = tmpStore();
  await store.appendJsonl('evt.jsonl', [{ a: 1 }, { a: 2 }]);
  await store.appendJsonl('evt.jsonl', { a: 3 });
  fs.appendFileSync(path.join(store.root, 'evt.jsonl'), 'not-json\n');
  const rows = store.readJsonl('evt.jsonl');
  assert.deepEqual(rows.map((r) => r.a), [1, 2, 3]);
});

test('list/remove/stat', async () => {
  const store = tmpStore();
  await store.writeJson('d/a.json', {});
  await store.writeJson('d/b.json', {});
  assert.deepEqual(store.list('d').sort(), ['a.json', 'b.json']);
  assert.ok(store.stat('d/a.json').size > 0);
  assert.equal(await store.remove('d/a.json'), true);
  assert.equal(await store.remove('d/a.json'), false);
  assert.deepEqual(store.list('d'), ['b.json']);
});

test('updateText：原子替换文本', async () => {
  const store = tmpStore();
  await store.writeJson('t.txt', {});
  const next = await store.updateText('t.txt', (cur) => cur + 'x');
  assert.equal(next, '{}\nx');
  assert.equal(fs.readFileSync(path.join(store.root, 't.txt'), 'utf8'), '{}\nx');
});

test('scope：带前缀写入物理隔离、互不覆盖', async () => {
  const store = tmpStore();
  const a = store.scope('conv/a');
  const b = store.scope('conv/b');
  await a.writeJson('state.json', { mood: 'warm' });
  await b.writeJson('state.json', { mood: 'cold' });
  assert.deepEqual(a.readJson('state.json'), { mood: 'warm' });
  assert.deepEqual(b.readJson('state.json'), { mood: 'cold' });
  // 文件落在各自 prefix 目录，跨 scope 不可见
  assert.deepEqual(fs.readdirSync(path.join(store.root, 'conv', 'a')), ['state.json']);
  assert.equal(fs.readFileSync(path.join(store.root, 'conv', 'b', 'state.json'), 'utf8').trim(), '{"mood":"cold"}');
  assert.equal(store.readJson('state.json', null), null);
});

test('scope：不同作用域的 updateJson 互不覆盖', async () => {
  const store = tmpStore();
  const a = store.scope('conv').scope('a');
  const b = store.scope('conv').scope('b');
  await a.writeJson('x.json', { v: 1 });
  await b.writeJson('x.json', { v: 2 });
  await a.updateJson('x.json', (c) => ({ v: (c?.v || 0) + 10 }));
  await b.updateJson('x.json', (c) => ({ v: (c?.v || 0) + 100 }));
  assert.equal(a.readJson('x.json').v, 11);
  assert.equal(b.readJson('x.json').v, 102);
});

test('scope：空前缀返回自身', () => {
  const store = tmpStore();
  assert.equal(store.scope(''), store);
});
