// [ACTIVITY-POOL] 聚合流水账不进默认召回（2026-10-30）
//
// 背景：group-digest 平均 172 字、group-compact 310 字、day-digest 254 字、browse 301 字，
// 而 fact 只有 31 字。长文本向量对任何 query 都"有点像"，会把原子事实挤下去
// （实测「主人的生日是哪天」top1 是当天浏览日志，正确答案排第 3）。
// 规则：只有时间向 query（最近/上次/这几天/群里聊什么…）才让聚合类进池。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTimeQuery, poolForQuery, AGGREGATE_KINDS } from '../src/domain/memory/memory-retrieve.js';

const entries = [
  { kind: 'fact', text: '主人的生日是 10 月 26 日' },
  { kind: 'event', text: '她今天把基建排好了' },
  { kind: 'group-digest', text: '群里在聊……' },
  { kind: 'group-compact', text: '【压缩】3 条群聊摘要……' },
  { kind: 'day-digest', text: '2026-10-26 这天：……' },
  { kind: 'browse', text: '今天网上看过：搜……' },
];
const kindsOf = (list) => list.map((e) => e.kind);

test('AGGREGATE_KINDS：四种聚合都在名单里', () => {
  for (const k of ['group-digest', 'group-compact', 'day-digest', 'browse']) assert.ok(AGGREGATE_KINDS.has(k), k);
  for (const k of ['fact', 'event', 'group-fact', 'impression']) assert.ok(!AGGREGATE_KINDS.has(k), k);
});

test('looksLikeTimeQuery：时间向 / 非时间向', () => {
  const yes = ['最近怎么样', '昨天群里聊什么', '上个月那件事', '上次基建干到一半卡在哪', '这几天她在干嘛', '后来呢', '近几天有谁来找过她'];
  for (const q of yes) assert.equal(looksLikeTimeQuery(q), true, q);
  const no = ['主人的生日是哪天', '明日方舟基建怎么搓龙门币', '她喜欢什么颜色', '画世界怎么把画发到 QQ'];
  for (const q of no) assert.equal(looksLikeTimeQuery(q), false, q);
  assert.equal(looksLikeTimeQuery(''), false);
  assert.equal(looksLikeTimeQuery(null), false);
});

test('poolForQuery：非时间向 query 剔除聚合类、事实与事件留下', () => {
  assert.deepEqual(kindsOf(poolForQuery(entries, '主人的生日是哪天')), ['fact', 'event']);
});

test('poolForQuery：时间向 query 原样返回（聚合仍可用）', () => {
  assert.deepEqual(kindsOf(poolForQuery(entries, '昨天群里聊什么')), kindsOf(entries));
});

test('poolForQuery：空 query（最近优先）与 activityPool=false 都原样返回', () => {
  assert.deepEqual(kindsOf(poolForQuery(entries, '')), kindsOf(entries));
  assert.deepEqual(kindsOf(poolForQuery(entries, '主人的生日是哪天', { activityPool: false })), kindsOf(entries));
});

test('poolForQuery：非数组输入不炸', () => {
  assert.deepEqual(poolForQuery(null, '生日'), []);
  assert.deepEqual(poolForQuery(undefined, '最近'), []);
});
