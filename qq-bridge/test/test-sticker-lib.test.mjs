// sticker-lib 单测：短引用、按情绪检索、自动打标字段（2026-10-26 表情包三处断点的回归）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stickerShortRef, pickStickerByQuery, findSticker, applyStickerNote,
  buildStickerContext, normalizeStickerEntry, mergeStickerLibrary,
} from '../src/domain/send/sticker-lib.js';

const LIB = [
  { id: 'x_1', md5: 'A1B2C3D4E5F60718', desc: '委屈巴巴', tags: ['安慰', '可怜'], useCount: 2 },
  { id: 'x_2', md5: '99887766AABBCCDD', desc: '笑到打滚', tags: ['搞笑', '笑'] },
  { id: 'x_3', md5: '12345678CCDDEEFF', desc: '', tags: [] },
];

test('stickerShortRef：优先 md5 前 8 位，便于写进提示词', () => {
  assert.equal(stickerShortRef(LIB[0]), 'A1B2C3D4');
  assert.equal(stickerShortRef({ id: '10002_0_0_0_6F30A3B4' }), '6F30A3B4');
  assert.equal(stickerShortRef(null), '');
});

test('findSticker：短引用/前缀都能指到同一张', () => {
  assert.equal(findSticker(LIB, 'A1B2C3D4')?.desc, '委屈巴巴');
  assert.equal(findSticker(LIB, '#a1b2c3d4')?.desc, '委屈巴巴');
  assert.equal(findSticker(LIB, '99887766')?.desc, '笑到打滚');
  assert.equal(findSticker(LIB, '不存在的引用'), null);
});

test('pickStickerByQuery：按情绪命中；多张同分时随机但仍在命中集里', () => {
  const r = pickStickerByQuery(LIB, '安慰', { random: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.entry.desc, '委屈巴巴');
  const r2 = pickStickerByQuery(LIB, '笑', { random: 0 });
  assert.equal(r2.entry.desc, '笑到打滚');
});

test('pickStickerByQuery：没匹配返回 no-match（调用方把清单还给她）', () => {
  const r = pickStickerByQuery(LIB, '孤独寂寞冷');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-match');
  assert.ok(r.entries.length === 3, '清单要原样带回去');
});

test('pickStickerByQuery：空 query = 随便一张；空库 = empty-library', () => {
  const r = pickStickerByQuery(LIB, '', { random: 0.99 });
  assert.equal(r.ok, true);
  assert.ok(r.entry, '要从库里挑一张');
  const empty = pickStickerByQuery([], '安慰');
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty-library');
});

test('applyStickerNote：能写 desc 并留 autoNoteAt；她手写覆盖时 autoNoteAt 清空', () => {
  const auto = applyStickerNote(LIB, 'A1B2C3D4', { desc: '机器叫它：瘪嘴', tags: ['安慰'], autoNoteAt: '2026-10-26T00:00:00Z' });
  assert.equal(auto.entry.desc, '机器叫它：瘪嘴');
  assert.equal(auto.entry.autoNoteAt, '2026-10-26T00:00:00Z');
  const manual = applyStickerNote(auto.entries, 'A1B2C3D4', { desc: '我想叫它：瘪嘴' });
  assert.equal(manual.entry.desc, '我想叫它：瘪嘴');
  assert.equal(manual.entry.autoNoteAt, '', '人工覆盖后不该再挂机器标记');
});

test('buildStickerContext：清单里带短引用（否则她拿到名字也发不出去）', () => {
  const text = buildStickerContext(LIB, 8);
  assert.ok(text.includes('[A1B2C3D4]'), '带短引用');
  assert.ok(text.includes('委屈巴巴'));
  assert.ok(text.includes('[安慰/可怜]'), '带标签');
  assert.ok(text.includes('（无备注，可先看图）'), '没备注的如实说');
});

test('normalizeStickerEntry：autoNoteAt 会被保留（不会被清洗掉）', () => {
  const e = normalizeStickerEntry({ id: 'y', desc: 'x', autoNoteAt: '2026-10-26T00:00:00Z' });
  assert.equal(e.autoNoteAt, '2026-10-26T00:00:00Z');
});

test('mergeStickerLibrary：QQ 侧空 desc 不能覆盖本地（否则每次同步都清掉机器名字/她的备注）', () => {
  const local = [{ id: 'a', md5: 'AA', desc: '缩成一团', tags: ['自闭'], autoNoteAt: '2026-10-26T00:00:00Z' }];
  const qqEmpty = [{ emoji_id: 'a', md5: 'AA', desc: '', url: 'http://x' }];
  const merged = mergeStickerLibrary(local, qqEmpty, { complete: true });
  assert.equal(merged[0].desc, '缩成一团');
  assert.deepEqual(merged[0].tags, ['自闭']);
  assert.ok(merged[0].autoNoteAt);
  const qqRemark = [{ emoji_id: 'a', md5: 'AA', desc: '他自己的备注' }];
  assert.equal(mergeStickerLibrary(local, qqRemark, { complete: true })[0].desc, '他自己的备注');
});
