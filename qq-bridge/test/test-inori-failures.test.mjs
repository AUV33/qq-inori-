// inori-failures 金标：错误文本归类、60 秒去重、窗口聚合、摘要口径、落盘上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS, CAUSES, classifyFailure, load, save, noteFailure, summarizeFailures, renderFailureDigest,
} from '../src/domain/leaves/inori-failures.js';

const NOW = 1_800_000_000_000;

test('classifyFailure：八类原因的关键词各自归位', () => {
  const cases = [
    ['群已禁言，result=120', 'mute'],
    ['ETIMEDOUT: socket hang up', 'network'],
    ['Messages request failed (400) context length too long', 'model'],
    ['401 未授权 token', 'auth'],
    ['429 rate limit exceeded', 'rate'],
    ['ENOENT 找不到路径', 'missing'],
    ['adb: no devices', 'device'],
    ['invalid config schema missing required field', 'config'],
    ['参数不能为空', 'validation'],
    ['完全看不懂的错误', 'unknown'],
  ];
  for (const [text, key] of cases) assert.equal(classifyFailure(text).key, key, text);
});

test('classifyFailure：优先级按 CAUSES 顺序（禁言先于网络、网络先于模型）', () => {
  assert.equal(classifyFailure('禁言中 ETIMEDOUT').key, 'mute');
  assert.equal(classifyFailure('timeout then Messages request failed (400)').key, 'network');
  assert.equal(CAUSES[CAUSES.length - 1].key, 'unknown', '兜底类在最后');
});

test('noteFailure：同工具同原因 60 秒内只记一次，换工具/超时都另记', () => {
  const log = { events: [] };
  const a = noteFailure(log, { at: NOW, key: 'group:1', tool: 'qq_send', text: '群已禁言' });
  assert.equal(a.counted, true);
  assert.equal(a.cause.key, 'mute');
  const b = noteFailure(log, { at: NOW + 30_000, key: 'group:1', tool: 'qq_send', text: '群已禁言' });
  assert.equal(b.counted, false, '60 秒内同工具同原因不重复记');
  assert.equal(log.events.length, 1);

  noteFailure(log, { at: NOW + 70_000, key: 'group:1', tool: 'qq_send', text: '群已禁言' });
  assert.equal(log.events.length, 2, '超过 60 秒要记');
  noteFailure(log, { at: NOW + 71_000, key: 'group:1', tool: 'phone', text: '群已禁言' });
  assert.equal(log.events.length, 3, '换工具要记');
});

test('noteFailure：文本压成一行并截断 160 字，事件保留 300 条上限', () => {
  const log = { events: [] };
  noteFailure(log, { at: NOW, tool: 't', text: '第一行\n第二行\t带制表符' });
  assert.equal(log.events[0].text, '第一行 第二行 带制表符');

  for (let i = 0; i < 320; i += 1) noteFailure(log, { at: NOW + 120_000 + i * 120_000, tool: `t${i}`, text: '别的错误' });
  assert.equal(log.events.length, DEFAULTS.cap);
});

test('summarizeFailures：只统计窗口内，原因/工具按次数降序，sample 取最后一条', () => {
  const log = { events: [
    { at: NOW - 40 * 60_000, cause: 'network', tool: 'a', text: '窗口外' },
    { at: NOW - 1000, cause: 'mute', tool: 'qq_send', text: '禁言了' },
    { at: NOW - 2000, cause: 'mute', tool: 'qq_send', text: '又禁言' },
    { at: NOW - 3000, cause: 'auth', tool: 'phone', text: '没权限' },
  ] };
  const s = summarizeFailures(log, { now: NOW });
  assert.equal(s.total, 3);
  assert.deepEqual(s.causes.map((c) => `${c.key}×${c.n}`), ['mute×2', 'auth×1']);
  assert.deepEqual(s.tools.map((t) => `${t.tool}×${t.n}`), ['qq_send×2', 'phone×1']);
  assert.equal(s.sample, '没权限', '最后一条');
  assert.equal(summarizeFailures({ events: [] }, { now: NOW }).total, 0);
});

test('renderFailureDigest：没有失败返回空串；有的话带次数/原因/工具/最后一条', () => {
  assert.equal(renderFailureDigest({ events: [] }, { now: NOW }), '');
  const log = { events: [{ at: NOW, cause: 'mute', tool: 'qq_send', text: '禁言了' }] };
  const text = renderFailureDigest(log, { now: NOW });
  assert.ok(text.startsWith('最近 30 分钟失败 1 次'));
  assert.ok(text.includes('被禁言/消息发不出去×1'));
  assert.ok(text.includes('（工具：qq_send×1）'));
  assert.ok(text.includes('最后一条：禁言了'));
});

test('load / save：往返一致；缺失/坏 JSON 当空；保存返回成功标志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fail-'));
  const file = path.join(dir, 'state', 'failure-log.json');
  assert.deepEqual(load(file), { events: [] }, '文件不存在时当空');

  const log = { events: [{ at: NOW, cause: 'mute', tool: 'x', text: 'a' }] };
  assert.equal(save(log, file), true);
  assert.deepEqual(load(file).events, log.events);

  fs.writeFileSync(file, '不是 JSON', 'utf8');
  assert.deepEqual(load(file), { events: [] });
});

test('save：超过上限只留最后 300 条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fail2-'));
  const file = path.join(dir, 'f.json');
  const events = Array.from({ length: 350 }, (_, i) => ({ at: i, cause: 'unknown', tool: 't', text: `e${i}` }));
  save({ events }, file);
  assert.equal(load(file).events.length, 300);
  assert.equal(load(file).events[299].text, 'e349', '留最新的');
});
