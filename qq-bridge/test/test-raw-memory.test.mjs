// [RAW] 原文层 + 结构化主张：写入、检索、剪枝、抽取的回归锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendRaw, loadRaw, searchRaw, pruneRaw, extractClaims, claimToMemoryRow, rawScope,
} from '../src/domain/leaves/inori-raw-memory.mjs';

const now = Date.parse('2026-10-30T19:30:00+08:00');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'raw-'));

test('appendRaw / loadRaw：按 scope 分文件，单行、截断', () => {
  const dir = tmp();
  try {
    assert.equal(appendRaw(dir, { key: 'group:123456789', at: now, sender: '群友戊', text: '被摸到规律了\n 一叫就冒头', seq: 404 }), true);
    assert.equal(appendRaw(dir, { key: 'private:10001', at: now, text: '私聊的事' }), true);
    assert.equal(appendRaw(dir, { key: 'group:123456789', text: '   ' }), false);
    const g = loadRaw(dir, 'group_123456789');
    assert.equal(g.length, 1);
    assert.equal(g[0].text, '被摸到规律了 一叫就冒头');
    assert.equal(g[0].scope, 'group_123456789');
    assert.equal(loadRaw(dir, 'private').length, 1);
    assert.equal(rawScope('group:123'), 'group_123');
    assert.equal(rawScope('private:9'), 'private');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('searchRaw：关键词/短句能命中，毫不相干的返回空', () => {
  const rows = [
    { text: '那你就别叫。', time: now },
    { text: '群友说：再来一次就踢了', time: now },
    { text: '今天天气不错', time: now },
  ];
  assert.ok(searchRaw(rows, '她说过别叫吗').length > 0, '短句命中');
  assert.ok(searchRaw(rows, '踢了').some((h) => h.row.text.includes('踢')), '关键词命中');
  assert.equal(searchRaw(rows, '量子力学').length, 0);
});

test('pruneRaw：超 30 天与被挤出上限的都清掉', () => {
  const dir = tmp();
  try {
    const old = now - 40 * 86400000;
    for (let i = 0; i < 3; i += 1) appendRaw(dir, { key: 'group:1', at: old + i, text: `旧${i}` });
    for (let i = 0; i < 5; i += 1) appendRaw(dir, { key: 'group:1', at: now - i * 1000, text: `新${i}` });
    const r = pruneRaw(dir, { maxAgeDays: 30, maxPerFile: 2, now });
    assert.equal(r.removed, 6);
    const left = loadRaw(dir, 'group_1');
    assert.equal(left.length, 2);
    assert.ok(left.every((x) => x.text.startsWith('新')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractClaims：只收高精度句式（承诺/偏好/冲突/计划），同文去重', () => {
  const rows = [
    { text: '我答应过下周陪他去', time: now, seq: 1, sender: '我' },
    { text: '我答应过下周陪他去', time: now + 1, seq: 2, sender: '我' }, // 重复
    { text: '他喜欢喝冰可乐', time: now, seq: 3, sender: '他' },
    { text: '群里刚才吵起来了', time: now, seq: 4, sender: '群友' },
    { text: '打算明天去趟银行', time: now, seq: 5, sender: '他' },
    { text: '今天天气不错', time: now, seq: 6, sender: '群友' },
  ];
  const claims = extractClaims(rows);
  const types = claims.map((c) => c.type).sort();
  assert.deepEqual(types, ['conflict', 'plan', 'preference', 'promise']);
  const promise = claims.find((c) => c.type === 'promise');
  assert.equal(claimToMemoryRow(promise, { scope: 'private' }).text.startsWith('[承诺]'), true);
});
