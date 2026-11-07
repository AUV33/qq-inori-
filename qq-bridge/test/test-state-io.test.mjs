// [MATRIX] state-io.mjs 的直接测试：纯工具 + 状态读写的容错与写失败可见性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateIo } from '../src/domain/shared/state-io.mjs';

function make(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-state-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const STATE_DIR = path.join(dir, 'state');
  const STATE_DATA_DIR = path.join(dir, 'data', 'state');
  const logs = [], writes = [], atomics = [];
  const io = createStateIo({
    STATE_DIR,
    STATE_DATA_DIR,
    log: (msg) => logs.push(String(msg)),
    writeJsonDocument: (f, v, opts) => {
      writes.push({ f, v, opts });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(v), 'utf8');
      return { ok: true };
    },
    atomicWriteJson: (f, v) => {
      atomics.push({ f, v });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(v), 'utf8');
    },
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    ...over,
  });
  return { dir, STATE_DIR, STATE_DATA_DIR, io, logs, writes, atomics };
}

test('纯工具：unquoteJsonString / stripUrls / sanitizeRoleName / oneBotError', (t) => {
  const { io } = make(t);
  assert.equal(io.unquoteJsonString('  "你好"  '), '你好');
  assert.equal(io.unquoteJsonString('"a"b'), '"a"b', '非纯 JSON 字符串原样返回');
  assert.equal(io.unquoteJsonString(123), 123);
  const cleaned = io.stripUrls('看这个 https://a.com/x?q=1 和 www.b.com 还有生日');
  assert.equal(cleaned.includes('https'), false);
  assert.equal(cleaned.includes('www.b.com'), false);
  assert.ok(cleaned.includes('生日'), 'URL 是语义噪声，但正文必须留下');
  assert.equal(io.sanitizeRoleName('Inori-小祈!@# 2'), 'Inori-小祈2');
  assert.match(io.oneBotError('send_msg', { status: 426 }, {}), /426.*snowluma\.httpUrl/);
  assert.match(io.oneBotError('send_msg', { status: 500 }, { retcode: 1200 }), /1200/);
});

test('状态读取：文件缺失时给默认值而非抛错；readRoleState 走注入的 readJsonSafe', (t) => {
  const { io } = make(t);
  assert.deepEqual(io.loadWishState(), { items: [] });
  assert.deepEqual(io.loadUnsentState(), { items: [] });
  assert.deepEqual(io.loadInterestEncounters(), { items: [] });
  assert.deepEqual(io.readRoleState(), { role: null, mode: 'active' });
});

test('状态写入：wish/unsent/interest/role 落盘正确且可回读', (t) => {
  const { io, writes, atomics, STATE_DIR, STATE_DATA_DIR } = make(t);
  io.saveWishState({ items: ['看海'] });
  io.saveUnsentState({ items: ['回信'] });
  io.saveInterestEncounters({ items: ['摄影'] });
  io.writeRoleState('小祈', 'paused');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].opts?.source, 'bridge/wish');
  assert.equal(writes[1].opts?.source, 'bridge/unsent');
  assert.deepEqual(io.loadWishState(), { items: ['看海'] });
  assert.deepEqual(io.loadUnsentState(), { items: ['回信'] });
  assert.deepEqual(io.loadInterestEncounters(), { items: ['摄影'] });
  assert.deepEqual(io.readRoleState(), { role: '小祈', mode: 'paused' });
  assert.ok(fs.existsSync(STATE_DIR) && fs.existsSync(STATE_DATA_DIR));
  assert.equal(atomics.length, 2, 'interest 与 role 各写一次');
  assert.deepEqual(io.readRoleState(), { role: '小祈', mode: 'paused' });
  io.writeRoleState(null, null);
  assert.deepEqual(io.readRoleState(), { role: null, mode: 'active' });
});

test('写失败可见：writeJsonDocument 返回 ok:false 时记日志，不静默丢状态', (t) => {
  const { io, logs } = make(t, { writeJsonDocument: () => ({ ok: false, error: '权限不足' }) });
  io.saveWishState({ items: ['约好的事'] });
  io.saveUnsentState({ items: ['挂心事'] });
  assert.ok(logs.some((l) => l.includes('保存失败') && l.includes('权限不足')));
  assert.equal(logs.filter((l) => l.includes('保存失败')).length, 2);
});

test('写盘抛异常不向外炸（best-effort 状态）', (t) => {
  const { io } = make(t, { writeJsonDocument: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => io.saveWishState({ items: ['x'] }));
  assert.doesNotThrow(() => io.saveUnsentState({ items: ['x'] }));
});
