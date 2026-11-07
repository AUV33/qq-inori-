// inori-state 金标：温度/精力的有界惯性（向基线衰减）、短即冷、perKey 合成与落盘可复现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSTS, loadState, saveState, tick, effectiveWarmth, stateWithKey, noteReply, pacingMultiplier, summary,
} from '../src/domain/leaves/inori-state.js';

const NOW = 1_800_000_000_000;
const H = 3600000;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-state-')), 'inori_state.json');
const fresh = () => ({ enabled: true, warmth: 0.5, energy: 0.6, at: NOW, replies: 0, shortStreak: 0, longStreak: 0, lastTalkAt: 0, perKey: {} });

test('CONSTS：半衰 2h（全局）/6h（perKey）、短句阈值 6 字、perKey 上限 20', () => {
  assert.equal(CONSTS.HALF_LIFE_MS, 2 * H);
  assert.equal(CONSTS.PERKEY_HALF_LIFE_MS, 6 * H);
  assert.equal(CONSTS.SHORT_REPLY_CHARS, 6);
  assert.equal(CONSTS.MAX_PERKEY, 20);
  assert.deepEqual(CONSTS.BASELINE, { warmth: 0.5, energy: 0.6 });
});

test('loadState：文件缺失/坏 JSON 返回默认；越界值被夹到 [0,1]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-state2-'));
  assert.equal(loadState(path.join(dir, 'nope.json')).warmth, 0.5);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '不是 JSON', 'utf8');
  assert.equal(loadState(bad).enabled, true);

  const wild = path.join(dir, 'wild.json');
  fs.writeFileSync(wild, JSON.stringify({ warmth: 9, energy: -3, perKey: { k: { warmth: 5, at: 1 } } }), 'utf8');
  const s = loadState(wild);
  assert.equal(s.warmth, 1);
  assert.equal(s.energy, 0);
  assert.equal(s.perKey.k.warmth, 1);
});

test('saveState：enabled=false 不落盘；正常往返一致', () => {
  const file = tmpFile();
  saveState({ ...fresh(), enabled: false }, file);
  assert.equal(fs.existsSync(file), false, '关掉状态就完全不写');

  const s = { ...fresh(), warmth: 0.7 };
  saveState(s, file);
  const back = loadState(file);
  assert.equal(back.warmth, 0.7);
  assert.equal(back.at, NOW);
});

test('tick：2 小时后与基线的差距走完一半（全局），perKey 走 6h 半衰', () => {
  const s = { ...fresh(), warmth: 0.9, energy: 0.6, perKey: { k: { warmth: 0.9, at: NOW } } };
  tick(s, NOW + 2 * H);
  assert.ok(Math.abs(s.warmth - (0.5 + 0.4 * 0.5)) < 1e-9, `实际 ${s.warmth}`);
  assert.ok(Math.abs(s.perKey.k.warmth - (0.5 + 0.4 * Math.pow(0.5, 1 / 3))) < 1e-9);
  assert.equal(s.at, NOW + 2 * H);
});

test('tick：dt=0 不动；坏 perKey 行被清掉；超过 20 个 key 只留最近的', () => {
  const s = fresh();
  tick(s, NOW);
  assert.equal(s.warmth, 0.5, '没经过时间不衰减');

  const dirty = { ...fresh(), perKey: { good: { warmth: 0.6, at: NOW }, bad: 'x' } };
  tick(dirty, NOW + 1000);
  assert.equal(dirty.perKey.bad, undefined);

  const many = { ...fresh(), perKey: {} };
  for (let i = 0; i < 30; i += 1) many.perKey[`k${i}`] = { warmth: 0.6, at: NOW - i * 1000 };
  tick(many, NOW);
  assert.equal(Object.keys(many.perKey).length, 20);
  assert.ok(many.perKey.k0, '保留最近互动的');
});

test('effectiveWarmth：有 perKey 时 = 全局 45% + 会话 55%；没有就用全局', () => {
  const s = { ...fresh(), warmth: 0.2, perKey: { 'group:1': { warmth: 1, at: NOW } } };
  assert.ok(Math.abs(effectiveWarmth(s, 'group:1') - (0.2 * 0.45 + 1 * 0.55)) < 1e-9);
  assert.equal(effectiveWarmth(s, 'group:2'), 0.2);
  assert.equal(effectiveWarmth(s, ''), 0.2);
});

test('stateWithKey：返回浅拷贝，不改原 state', () => {
  const s = { ...fresh(), warmth: 0.2, perKey: { k: { warmth: 1, at: NOW } } };
  const view = stateWithKey(s, 'k');
  assert.notEqual(view, s);
  assert.ok(view.warmth > s.warmth);
  assert.equal(s.warmth, 0.2);
});

test('noteReply：短句连着说越来越冷（第 1 条 3%、第 3 条 9%），不会归零', () => {
  const s = fresh();
  noteReply(s, '嗯', NOW);
  const after1 = s.warmth;
  noteReply(s, '嗯', NOW + 1000);
  noteReply(s, '嗯', NOW + 2000);
  assert.equal(s.shortStreak, 3);
  assert.ok(after1 < 0.5);
  assert.ok(s.warmth > 0, '乘当前值 → 不会归零');
  assert.ok(s.warmth < after1);
});

test('noteReply：长回复回暖（按 1-当前 比例，接不到 1）且消耗精力', () => {
  const s = { ...fresh(), warmth: 0.9, energy: 0.6 };
  noteReply(s, '这是一句足够长的回复内容，用来验证回暖与精力消耗', NOW);
  assert.ok(s.warmth > 0.9 && s.warmth < 1);
  assert.ok(s.energy < 0.6);
  assert.equal(s.longStreak, 1);
  assert.equal(s.shortStreak, 0);
});

test('noteReply：带 key 时同时更新 perKey，且 replies 计数', () => {
  const s = fresh();
  noteReply(s, '这是一句很长的回复', NOW, 'group:1');
  assert.ok(s.perKey['group:1']);
  assert.equal(s.perKey['group:1'].at, NOW);
  assert.equal(s.replies, 1);
  assert.ok(effectiveWarmth(s, 'group:1') > 0.5);
});

test('pacingMultiplier：温度越高气泡越多、间隔越短', () => {
  const hot = pacingMultiplier({ warmth: 1, energy: 1 });
  const cold = pacingMultiplier({ warmth: 0, energy: 0 });
  assert.ok(hot.maxBurst > cold.maxBurst);
  assert.ok(hot.gapScale < cold.gapScale);
  assert.ok(hot.gapScale > 0);
});

test('summary：关掉返回空串；否则带温度/精力/距上次说话', () => {
  assert.equal(summary({ ...fresh(), enabled: false }), '');
  const text = summary({ ...fresh(), warmth: 0.7, energy: 0.8, lastTalkAt: NOW - 5 * 60000 }, NOW);
  assert.ok(text.includes('温度 0.70（偏暖）'));
  assert.ok(text.includes('精力 0.80（有精神）'));
  assert.ok(text.includes('距上次说话 5 分钟'));
  assert.ok(summary({ ...fresh(), lastTalkAt: NOW }, NOW).includes('刚说完话'));
});

test('回暖是向 1 收缩：越暖增量越小；0.95 再撑一句也到不了 1', () => {
  const a = fresh();
  const b = fresh();
  b.warmth = 0.9;
  noteReply(a, '这是一句挺长的话，够十个字以上了', NOW, 'k');
  noteReply(b, '这是一句挺长的话，够十个字以上了', NOW, 'k');
  assert.ok((a.warmth - 0.5) > (b.warmth - 0.9), `0.5→${a.warmth}，0.9→${b.warmth}`);

  const c = fresh();
  c.warmth = 0.95;
  noteReply(c, '这是一句挺长的话，够十个字以上了', NOW, 'k');
  assert.ok(c.warmth < 1 && c.warmth > 0.95, '向 1 收缩，不顶死');
});

test('perKey：对 A 暖、对 B 冷，全局夹在中间；落盘后 perKey 还在', () => {
  const s = fresh();
  for (let i = 0; i < 6; i += 1) noteReply(s, '这是很长的一句回应，肯定超过六个字了', NOW + i, 'private:1001');
  for (let i = 0; i < 4; i += 1) noteReply(s, '嗯', NOW + i, 'group:2002');
  const wa = effectiveWarmth(s, 'private:1001');
  const wb = effectiveWarmth(s, 'group:2002');
  assert.ok(wa > wb, `对 A(${wa}) 应比对 B(${wb}) 暖`);
  assert.ok(wa > s.warmth && wb < s.warmth, `全局(${s.warmth}) 应夹在中间`);

  const file = tmpFile();
  saveState(s, file);
  const back = loadState(file);
  assert.ok(back.perKey['private:1001'], 'perKey 应被保存');
});

test('summary 可指定会话：给了 key 就用该会话的温度', () => {
  const s = fresh();
  noteReply(s, '这是一句挺长的话，够十个字以上了', NOW, 'private:8');
  const line = summary(s, NOW, 'private:8');
  assert.ok(/温度 \d\.\d\d/.test(line), `实际：${line}`);
});
