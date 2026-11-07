// bootstrap/runtime-state 金标：会话 kind 账本（30 天裁剪）与控制台 token（缺失才生成、之后复用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionKindStore, createConsoleTokenStore } from '../src/bootstrap/runtime-state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rtstate-'));

test('createSessionKindStore：文件不存在从空账本开始，record 后能落盘', () => {
  const dir = tmp();
  const file = path.join(dir, 'session-kinds.json');
  const writes = [];
  const store = createSessionKindStore({ file, writeJson: (f, v) => { writes.push({ f, v }); fs.writeFileSync(f, JSON.stringify(v)); } });
  assert.deepEqual(store.kinds, {});
  store.record('sid-1', 'gate');
  assert.equal(store.kinds['sid-1'].kind, 'gate');
  assert.ok(store.kinds['sid-1'].at > 0);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['sid-1'].kind, 'gate');
});

test('createSessionKindStore：重新加载已有账本；坏 JSON 当空', () => {
  const dir = tmp();
  const file = path.join(dir, 'sk.json');
  fs.writeFileSync(file, JSON.stringify({ a: { kind: 'task', at: Date.now() } }));
  const store = createSessionKindStore({ file, writeJson: () => {} });
  assert.equal(store.kinds.a.kind, 'task');

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{不是 JSON');
  assert.deepEqual(createSessionKindStore({ file: bad, writeJson: () => {} }).kinds, {});
});

test('createSessionKindStore：超过 30 天的记录在下次 record 时被裁掉', () => {
  const dir = tmp();
  const file = path.join(dir, 'sk2.json');
  const old = { 'sid-old': { kind: 'task', at: Date.now() - 31 * 86400000 } };
  fs.writeFileSync(file, JSON.stringify(old));
  const store = createSessionKindStore({ file, writeJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v)) });
  store.record('sid-new', 'ownlife');
  assert.equal(store.kinds['sid-old'], undefined, '31 天前的记录要清掉');
  assert.equal(store.kinds['sid-new'].kind, 'ownlife');
});

test('createSessionKindStore：空 sid/kind 不记账；writeJson 抛错也不外溢', () => {
  const dir = tmp();
  const store = createSessionKindStore({ file: path.join(dir, 'x.json'), writeJson: () => { throw new Error('磁盘满'); } });
  store.record('', 'gate');
  store.record('sid', '');
  assert.deepEqual(store.kinds, {});
  assert.doesNotThrow(() => store.record('sid', 'gate'));
});

test('createConsoleTokenStore：已有 token 直接复用，且不标记为新建', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'console-token'), 'existing-token\n');
  const store = createConsoleTokenStore({ stateDir: dir, writeText: () => { throw new Error('不该写'); } });
  assert.equal(store.loadOrCreate(), 'existing-token');
  assert.equal(store.wasCreated(), false);
});

test('createConsoleTokenStore：缺失时生成 48 位 hex 并写盘，第二次调用复用同一枚', () => {
  const dir = tmp();
  const written = [];
  const store = createConsoleTokenStore({ stateDir: dir, writeText: (file, text) => { written.push({ file, text }); fs.writeFileSync(file, text); } });
  const first = store.loadOrCreate();
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(store.wasCreated(), true);
  assert.equal(written.length, 1);
  assert.equal(store.loadOrCreate(), first, '第二次必须复用已写盘的 token');
});

test('createConsoleTokenStore：空文件视为缺失（重新生成）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'console-token'), '   \n');
  const writes = [];
  const store = createConsoleTokenStore({ stateDir: dir, writeText: (f, t) => { writes.push(t); fs.writeFileSync(f, t); } });
  const token = store.loadOrCreate();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(writes.length, 1);
});
