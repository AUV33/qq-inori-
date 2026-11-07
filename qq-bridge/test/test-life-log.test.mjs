import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLifeLog } from '../src/domain/shared/life-log.mjs';

function tmpLog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'life-log-'));
  let fakeNow = 1793713000000;
  const log = createLifeLog({ root, clock: () => fakeNow, idFactory: (() => { let i = 0; return () => 'evt_t' + (++i); })() });
  return { log, root, setNow: (v) => { fakeNow = v; } };
}

const DAY = 24 * 3600 * 1000;

test('append/read：字段归一，按时间排序', () => {
  const { log } = tmpLog();
  log.append({ type: 'message.received', key: 'private:1', payload: { text: 'hi' } }, { at: 1000 });
  log.append({ type: 'message.sent', key: 'private:1', payload: { text: 'hello' } }, { at: 2000 });
  const rows = log.read();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'message.received');
  assert.equal(rows[1].payload.text, 'hello');
  assert.ok(rows[0].id && rows[0].v === 1);
});

test('按天分段：跨日写两个文件', () => {
  const { log, root } = tmpLog();
  const day1 = Date.UTC(2026, 10, 3, 12, 0, 0);
  log.append({ type: 'process.started' }, { at: day1 });
  log.append({ type: 'sleep.started' }, { at: day1 + DAY });
  const files = log.files();
  assert.equal(files.length, 2);
  assert.ok(fs.existsSync(path.join(root, files[0])));
});

test('read：type/key/时间过滤与 limit', () => {
  const { log } = tmpLog();
  for (let i = 0; i < 10; i += 1) {
    log.append({ type: i % 2 ? 'message.received' : 'message.sent', key: i < 5 ? 'a' : 'b', payload: { i } }, { at: 1000 + i * 1000 });
  }
  assert.equal(log.read({ type: 'message.received' }).length, 5);
  assert.equal(log.read({ key: 'a' }).length, 5);
  assert.equal(log.read({ from: 5000 }).length, 6);
  assert.equal(log.read({ limit: 3 }).length, 3);
  assert.equal(log.read({ limit: 3 })[2].payload.i, 9);
});

test('tail：最近 N 条', () => {
  const { log } = tmpLog();
  for (let i = 0; i < 20; i += 1) log.append({ type: 'tick', payload: { i } }, { at: 1000 + i });
  const rows = log.tail(5);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.payload.i), [15, 16, 17, 18, 19]);
});

test('坏行容错：跳过不炸', () => {
  const { log, root } = tmpLog();
  const at = Date.UTC(2026, 10, 3, 1, 0, 0);
  log.append({ type: 'a' }, { at });
  const file = path.join(root, log.fileOf(at).split(path.sep).pop());
  fs.appendFileSync(file, '{oops}\n');
  assert.equal(log.read().length, 1);
});

test('replay/stats：回放计数与统计', () => {
  const { log } = tmpLog();
  for (let i = 0; i < 3; i += 1) log.append({ type: 'x', payload: { i } }, { at: 1000 + i });
  let seen = 0;
  const n = log.replay({}, () => { seen += 1; });
  assert.equal(n, 3);
  assert.equal(seen, 3);
  const s = log.stats();
  assert.equal(s.days, 1);
  assert.equal(s.events, 3);
  assert.ok(s.bytes > 0);
});

test('非法事件被拒绝', () => {
  const { log } = tmpLog();
  assert.throws(() => log.append({ payload: {} }), /type required/);
  assert.throws(() => log.append(null), /event object required/);
});

test('payload 深对象往返', () => {
  const { log } = tmpLog();
  log.append({ type: 'belief.updated', payload: { nested: { a: [1, 2, 3] } } }, { at: 1000 });
  assert.deepEqual(log.read()[0].payload, { nested: { a: [1, 2, 3] } });
});
