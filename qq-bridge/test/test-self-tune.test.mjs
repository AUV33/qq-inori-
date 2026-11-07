// [SELF-TUNE] 她自己调行为参数的回归锁：白名单/边界/整批拒绝/原子写/审计/热读缓存。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TUNE_PARAMS, validateUpdate, readTuningFile, applyTuning, createTuningReader } from '../src/domain/persona/self-tune.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'self-tune-'));

test('白名单：认识的参数按边界校验，越界/类型错/未知键都拒绝', () => {
  assert.equal(validateUpdate('floor.minReply', 0.3).ok, true);
  assert.equal(validateUpdate('floor.minReply', 0.01).ok, false);
  assert.equal(validateUpdate('floor.minReply', 0.99).ok, false);
  assert.equal(validateUpdate('floor.minReply', '0.3').ok, true, '数字字符串也接受');
  assert.equal(validateUpdate('floor.minReply', 'abc').ok, false);
  assert.equal(validateUpdate('floor.adaptive', true).ok, true);
  assert.equal(validateUpdate('floor.adaptive', 'yes').ok, false);
  assert.equal(validateUpdate('floor.holdScale', 0.4).ok, false);
  assert.equal(validateUpdate('floor.holdScale', 2.1).ok, false);
  assert.equal(validateUpdate('floor.nope', 1).ok, false);
  assert.ok(Object.keys(TUNE_PARAMS).length >= 3);
});

test('提示词装饰底：0–2000 可调（她可以自己决定装饰层留多少），越界拒绝', () => {
  assert.equal(validateUpdate('prompt.decoFloor', 0).ok, true);
  assert.equal(validateUpdate('prompt.decoFloor', 600).ok, true);
  assert.equal(validateUpdate('prompt.decoFloor', 2000).ok, true);
  assert.equal(validateUpdate('prompt.decoFloor', -1).ok, false);
  assert.equal(validateUpdate('prompt.decoFloor', 2001).ok, false);
  assert.equal(validateUpdate('prompt.decoFloor', 'abc').ok, false);
});

test('整批拒绝：一个非法项就整批不写（不做半套）', () => {
  const dir = tmp();
  const file = path.join(dir, 'tuning.json');
  const logFile = path.join(dir, 'tuning.jsonl');
  const bad = applyTuning({ params: {} }, { 'floor.minReply': 0.3, 'floor.nope': 1 }, { file, logFile });
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(file), false, '失败时不该留文件');
});

test('写入：原子落盘 + .bak + 审计行 + 返回 applied', () => {
  const dir = tmp();
  const file = path.join(dir, 'tuning.json');
  const logFile = path.join(dir, 'tuning.jsonl');
  const first = applyTuning({ params: {} }, { 'floor.minReply': 0.3 }, { file, logFile, reason: '群里太吵' });
  assert.equal(first.ok, true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.params['floor.minReply'], 0.3);
  assert.equal(doc.by, 'her');
  assert.equal(doc.reason, '群里太吵');
  const second = applyTuning(first.next, { 'floor.holdScale': 1.5 }, { file, logFile });
  assert.equal(second.ok, true);
  assert.ok(fs.existsSync(`${file}.bak`), '第二次写要留上一版');
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].applied['floor.holdScale'], 1.5);
  assert.equal(rows[1].next['floor.minReply'], 0.3, '审计里保留合并后的全量');
});

test('读取：坏文件/越界值被忽略，回落空对象', () => {
  const dir = tmp();
  const file = path.join(dir, 'tuning.json');
  assert.deepEqual(readTuningFile(file).params, {}, '文件不存在');
  fs.writeFileSync(file, '{坏 json');
  assert.deepEqual(readTuningFile(file).params, {}, '坏 JSON');
  fs.writeFileSync(file, JSON.stringify({ params: { 'floor.minReply': 9, 'floor.adaptive': false } }));
  const r = readTuningFile(file);
  assert.equal(r.params['floor.minReply'], undefined, '越界值丢弃');
  assert.equal(r.params['floor.adaptive'], false);
});

test('热读缓存：文件不变不重复解析，改了下一次能读到', () => {
  const dir = tmp();
  const file = path.join(dir, 'tuning.json');
  applyTuning({ params: {} }, { 'floor.minReply': 0.25 }, { file });
  const read = createTuningReader(file);
  assert.equal(read()['floor.minReply'], 0.25);
  // 手写一次（模拟别的进程改）：mtime 变化后必须读到新值
  const later = new Date(Date.now() + 2000);
  fs.writeFileSync(file, JSON.stringify({ params: { 'floor.minReply': 0.4 } }));
  fs.utimesSync(file, later, later);
  assert.equal(read()['floor.minReply'], 0.4);
});
