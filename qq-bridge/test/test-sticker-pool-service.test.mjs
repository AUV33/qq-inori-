// sticker-pool-service 金标：候选入池/去重/TTL/池上限、打标批处理、自动收藏闸门、递图一行。
//
// 模块自身不 import 项目内任何东西（全部注入），这里用真 fs（mkdtemp）+ 真 atomicWriteJson +
// 真 parseStickerCaption/applyStickerNote 跑持久化与文本链路，其余运行时依赖用桩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStickerPool } from '../src/domain/social/sticker-pool-service.mjs';
import { atomicWriteJson } from '../src/bootstrap/fs-utils.mjs';
import { parseStickerCaption, applyStickerNote, stickerShortRef } from '../src/domain/send/sticker-lib.js';
import { evaluateAutoCollect, evaluateCaptionRetry } from '../src/domain/send/sticker-autocollect.mjs';

const GOOD_CAPTION = JSON.stringify({
  name: '委屈巴巴',
  tags: ['安慰', '可怜'],
  note: '抱抱你',
  meaning: '想被安慰一下',
  sticker: true,
  collect: true,
});

function makePool(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = {
    logs: [],
    savedStores: [],
    setEntries: 0,
    fetched: [],
    vision: [],
    safeFetch: [],
    botRequests: [],
    resync: [],
    syncCalls: [],
  };
  const box = {
    entries: [],
    media: [{ data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png' }],
  };
  const ctx = {
    fs,
    path,
    cfg: { socialV2: { sticker: { pool: { enabled: true, inject: true }, autoCollect: { enabled: true } } } },
    log: (m) => calls.logs.push(String(m)),
    STATE_DIR: dir,
    STICKER_FILE: path.join(dir, 'stickers.json'),
    atomicWriteJson,
    stickerService: { setEntries: (e) => { box.entries = e; calls.setEntries += 1; } },
    loadStickerStore: () => box.entries,
    saveStickerStore: (file, entries) => { calls.savedStores.push({ file, entries }); },
    getStickerImageData: async (id) => ({ id, url: `https://example.test/${id}.png` }),
    applyStickerNote,
    stickerEnabled: () => true,
    syncStickerLibrary: async (force) => { calls.syncCalls.push(force); return { entries: [], fromCache: false }; },
    fetchMediaData: async (media) => { calls.fetched.push(media); return box.media; },
    visionAsk: async (imgs, prompt, mime) => {
      calls.vision.push({ imgs, prompt, mime });
      return GOOD_CAPTION;
    },
    mimeFromBuffer: () => 'image/png',
    safeFetchBuffer: async (url, max) => {
      calls.safeFetch.push({ url, max });
      return { buffer: Buffer.from('img-bytes') };
    },
    parseStickerCaption,
    evaluateCaptionRetry,
    evaluateAutoCollect,
    stickerShortRefOf: stickerShortRef,
    activityTracker: {},
    getStickerSyncedAt: () => 0,
    getStickerResyncAt: () => 0,
    setStickerResyncAt: (v) => calls.resync.push(v),
    isDshReady: () => true,
    MAX_MEDIA_BYTES: 4096,
    // [BUG] 模块里 bot.request 是裸引用（未从 ctx 取）；这里照样注入，修好后应被用上。
    bot: { request: async (action, params) => {
      calls.botRequests.push({ action, params });
      return { status: 'ok', retcode: 0, data: { emoji_id: 'EMOJI-1' } };
    } },
  };
  ctx.getBot = () => ctx.bot;
  Object.assign(ctx, overrides.ctx ?? {});
  const pool = createStickerPool(ctx);
  const poolFile = path.join(ctx.STATE_DIR, 'sticker-pool.json');
  const metaFile = path.join(ctx.STATE_DIR, 'sticker-pool-meta.json');
  return { pool, ctx, box, calls, dir, poolFile, metaFile };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');

function poolItem(over = {}) {
  return {
    id: 'i1',
    key: 'group:1',
    messageId: '1001',
    sender: '群友A',
    media: { kind: 'image', url: 'https://example.test/a.png' },
    at: Date.now(),
    desc: '',
    captionedAt: 0,
    shownAt: 0,
    collected: false,
    ...over,
  };
}

// ── 持久化小工具 ──────────────────────────────────────────────────────────
test('poolMeta：文件缺失 / 坏 JSON / 非对象都回 {}，好 JSON 原样返回', (t) => {
  const h = makePool(t);
  assert.deepEqual(h.pool.poolMeta(), {}, '文件不存在');
  fs.writeFileSync(h.metaFile, '{ 这不是 JSON');
  assert.deepEqual(h.pool.poolMeta(), {}, '坏 JSON');
  writeJson(h.metaFile, 123);
  assert.deepEqual(h.pool.poolMeta(), 123, 'JSON 数字按原值返回（调用方 spread 时自动退化）');
  writeJson(h.metaFile, { lastCaptionAt: 42 });
  assert.deepEqual(h.pool.poolMeta(), { lastCaptionAt: 42 });
});

test('setPoolMeta：合并不覆盖其它键，并且落盘可读回', (t) => {
  const h = makePool(t);
  writeJson(h.metaFile, { autoCount: 2 });
  h.pool.setPoolMeta({ lastCaptionAt: 100 });
  assert.deepEqual(readJson(h.metaFile), { autoCount: 2, lastCaptionAt: 100 });
  h.pool.setPoolMeta({ autoHourCount: 1 });
  assert.deepEqual(h.pool.poolMeta(), { autoCount: 2, lastCaptionAt: 100, autoHourCount: 1 });
});

test('setPoolMeta / saveStickerPool：写盘失败静默（STATE_DIR 被文件占住也不抛）', (t) => {
  const h = makePool(t);
  const blocked = path.join(h.dir, 'blocked');
  fs.writeFileSync(blocked, 'occupied');
  const h2 = makePool(t, { ctx: { STATE_DIR: blocked } });
  assert.doesNotThrow(() => h2.pool.setPoolMeta({ x: 1 }));
  assert.deepEqual(h2.pool.poolMeta(), {});
  assert.doesNotThrow(() => h2.pool.saveStickerPool([{ id: 'x' }]));
  assert.deepEqual(h2.pool.loadStickerPool(), []);
});

test('loadStickerPool：文件缺失/坏 JSON/JSON 非数组都回空数组', (t) => {
  const h = makePool(t);
  assert.deepEqual(h.pool.loadStickerPool(), []);
  fs.writeFileSync(h.poolFile, 'not-json');
  assert.deepEqual(h.pool.loadStickerPool(), []);
  writeJson(h.poolFile, { not: 'array' });
  assert.deepEqual(h.pool.loadStickerPool(), []);
  writeJson(h.poolFile, [{ id: 'a' }]);
  assert.deepEqual(h.pool.loadStickerPool(), [{ id: 'a' }]);
});

test('saveStickerPool：写入可被 loadStickerPool 读回', (t) => {
  const h = makePool(t);
  h.pool.saveStickerPool([{ id: 'a', at: 1 }]);
  assert.deepEqual(readJson(h.poolFile), [{ id: 'a', at: 1 }]);
  assert.deepEqual(h.pool.loadStickerPool(), [{ id: 'a', at: 1 }]);
});

// ── 候选入池 ──────────────────────────────────────────────────────────────
test('recordStickerCandidate：非群聊 / 关闭开关 / 空媒体 / 无 messageRef 都不记', (t) => {
  const h = makePool(t);
  const media = [{ kind: 'image', url: 'https://example.test/a.png' }];
  h.pool.recordStickerCandidate('private:1', media, '她', '1');
  h.pool.recordStickerCandidate('group:1', media, '她', '');
  h.pool.recordStickerCandidate('group:1', [], '她', '2');
  h.pool.recordStickerCandidate('group:1', [{ kind: 'video' }], '她', '3');
  assert.equal(fs.existsSync(h.poolFile), false);

  const disabled = makePool(t, { ctx: { cfg: { socialV2: { sticker: { pool: { enabled: false } } } } } });
  disabled.pool.recordStickerCandidate('group:1', media, '她', '4');
  assert.equal(fs.existsSync(disabled.poolFile), false);
  assert.equal(disabled.calls.logs.length, 0);
});

test('recordStickerCandidate：正常入池（字段、首个有效媒体、日志）', (t) => {
  const h = makePool(t);
  const before = Date.now();
  h.pool.recordStickerCandidate(
    'group:1',
    [{ kind: 'video', url: '' }, { kind: 'face', file: 'face-1' }],
    '群友A',
    1001,
  );
  const items = readJson(h.poolFile);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.key, 'group:1');
  assert.equal(item.messageId, '1001');
  assert.equal(item.sender, '群友A');
  assert.deepEqual(item.media, { kind: 'face', file: 'face-1' }, '取第一个 face/image/url/file 的媒体');
  assert.ok(item.at >= before, 'at 用当前毫秒时间戳');
  assert.equal(item.id, item.at.toString(36));
  assert.equal(item.desc, '');
  assert.equal(item.captionedAt, 0);
  assert.equal(item.shownAt, 0);
  assert.equal(item.collected, false);
  assert.ok(h.calls.logs.some((l) => l.includes('记下一条候选图（池 1）')));
});

test('recordStickerCandidate：同 messageId 去重，不重复入池也不重复写日志', (t) => {
  const h = makePool(t);
  const media = [{ kind: 'image', url: 'https://example.test/a.png' }];
  h.pool.recordStickerCandidate('group:1', media, '群友A', 2002);
  h.pool.recordStickerCandidate('group:1', media, '群友B', '2002');
  assert.equal(readJson(h.poolFile).length, 1);
  assert.equal(h.calls.logs.filter((l) => l.includes('候选图')).length, 1);
});

test('recordStickerCandidate：超过 7 天的脏条目被清掉，新条目补进来', (t) => {
  const h = makePool(t);
  const DAY = 24 * 3600 * 1000;
  writeJson(h.poolFile, [
    poolItem({ id: 'old', messageId: '1', at: Date.now() - 8 * DAY }),
    poolItem({ id: 'fresh', messageId: '2', at: Date.now() - 6 * DAY, desc: '旧但还在' }),
    { id: 'no-at', messageId: '3' },
  ]);
  h.pool.recordStickerCandidate('group:1', [{ kind: 'image', url: 'x' }], '她', '4');
  const items = readJson(h.poolFile);
  assert.deepEqual(items.map((x) => x.id).slice(0, 1), ['fresh']);
  assert.equal(items.length, 2);
  assert.equal(items[1].messageId, '4');
});

test('recordStickerCandidate：池上限 30，溢出时裁掉最旧的', (t) => {
  const h = makePool(t);
  const seed = Array.from({ length: 30 }, (_, i) => poolItem({ id: `s${i}`, messageId: `m${i}`, at: Date.now() - (30 - i) * 1000 }));
  writeJson(h.poolFile, seed);
  h.pool.recordStickerCandidate('group:1', [{ kind: 'image', url: 'x' }], '她', 'new');
  const items = readJson(h.poolFile);
  assert.equal(items.length, 30);
  assert.equal(items[0].id, 's1', '最旧的 s0 被裁掉');
  assert.equal(items.at(-1).messageId, 'new');
});

// ── 批量打标 ──────────────────────────────────────────────────────────────
test('captionStickerLibrary：开关关闭时直接拒绝，不读库', (t) => {
  const h = makePool(t, { ctx: { stickerEnabled: () => false } });
  return h.pool.captionStickerLibrary().then((res) => {
    assert.deepEqual(res, { ok: false, error: '表情包体系已关闭' });
  });
});

test('captionStickerLibrary：表情库读不出时返回错误，不抛', async (t) => {
  const h = makePool(t, { ctx: { loadStickerStore: () => { throw new Error('disk boom'); } } });
  const res = await h.pool.captionStickerLibrary();
  assert.equal(res.ok, false);
  assert.match(res.error, /表情库读不出：disk boom/);
});

test('captionStickerLibrary：都有备注时不打标', async (t) => {
  const h = makePool(t);
  h.box.entries = [{ id: 'a', desc: '有名字', localNote: '有备注' }];
  const res = await h.pool.captionStickerLibrary();
  assert.deepEqual(res, { ok: true, done: 0, note: '没有需要打标的（都有备注了）' });
  assert.equal(h.calls.vision.length, 0);
});

test('captionStickerLibrary：只打缺备注的，落盘 + 同步服务 + 回执', async (t) => {
  const h = makePool(t);
  h.box.entries = [
    { id: 'a', desc: '', localNote: '' },
    { id: 'b', desc: '有名字', localNote: '有备注' },
    { id: 'c', desc: '', localNote: '有备注' },
  ];
  const res = await h.pool.captionStickerLibrary({ limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.done, 2);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(res.receipts.map((r) => r.ref).sort(), [stickerShortRef({ id: 'a' }), stickerShortRef({ id: 'c' })].sort());
  assert.deepEqual(res.receipts.find((r) => r.ref === stickerShortRef({ id: 'a' })), { ref: stickerShortRef({ id: 'a' }), desc: '委屈巴巴', tags: ['安慰', '可怜'] });
  assert.equal(h.calls.safeFetch[0].url, 'https://example.test/a.png');
  assert.equal(h.calls.safeFetch[0].max, 4096, '下载受 MAX_MEDIA_BYTES 约束');
  assert.equal(h.calls.vision[0].mime, 'image/png');
  assert.equal(h.calls.vision[0].prompt.includes('只输出一行 JSON'), true);
  assert.equal(h.calls.savedStores.length, 1);
  assert.equal(h.calls.setEntries, 1);
  const saved = h.calls.savedStores[0].entries;
  assert.equal(saved.find((e) => e.id === 'a').desc, '委屈巴巴');
  assert.equal(saved.find((e) => e.id === 'a').localNote, '抱抱你');
  assert.deepEqual(saved.find((e) => e.id === 'a').tags, ['安慰', '可怜']);
  assert.equal(saved.find((e) => e.id === 'a').source, 'ai');
  assert.match(saved.find((e) => e.id === 'a').autoNoteAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.find((e) => e.id === 'b').desc, '有名字', '有备注的不被动');
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker-caption] 「委屈巴巴」[安慰/可怜]')));
});

test('captionStickerLibrary：limit 下限 1、0 回落 2、可被 force 重打已有备注', async (t) => {
  const h = makePool(t);
  h.box.entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal((await h.pool.captionStickerLibrary({ limit: 0 })).done, 2, '0 走默认 2');
  h.box.entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal((await h.pool.captionStickerLibrary({ limit: -5 })).done, 1, '负数收敛到 1');
  h.box.entries = [{ id: 'a', desc: '已有', localNote: '已有' }, { id: 'b', desc: '已有', localNote: '已有' }];
  assert.equal((await h.pool.captionStickerLibrary({ force: true })).done, 2, 'force 时全量重打');
});

test('captionStickerLibrary：单条失败不挡后面，失败 id 进 failed', async (t) => {
  const h = makePool(t, {
    ctx: {
      getStickerImageData: async (id) => {
        if (id === 'bad') throw new Error('取图失败');
        return { id, url: `https://example.test/${id}.png` };
      },
    },
  });
  h.box.entries = [{ id: 'bad' }, { id: 'ok' }];
  const res = await h.pool.captionStickerLibrary({ limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.done, 1);
  assert.deepEqual(res.failed, ['bad']);
  assert.deepEqual(res.receipts.map((r) => r.ref), [stickerShortRef({ id: 'ok' })]);
  assert.ok(h.calls.logs.some((l) => l.includes('打标失败 bad')));
});

test('captionStickerLibrary：模型没给出名字（空文本）计为失败，不写空条目', async (t) => {
  const h = makePool(t, { ctx: { visionAsk: async () => '' } });
  h.box.entries = [{ id: 'a' }];
  const res = await h.pool.captionStickerLibrary();
  assert.equal(res.done, 0);
  assert.deepEqual(res.failed, ['a']);
  assert.equal(h.calls.savedStores.length, 0, '没成功就不落盘');
});

test('captionStickerLibrary：落盘失败只记日志，结果仍算成功', async (t) => {
  const h = makePool(t, {
    ctx: { saveStickerStore: () => { throw new Error('write denied'); } },
  });
  h.box.entries = [{ id: 'a' }];
  const res = await h.pool.captionStickerLibrary();
  assert.equal(res.ok, true);
  assert.equal(res.done, 1);
  assert.ok(h.calls.logs.some((l) => l.includes('落盘失败: write denied')));
});

// ── 自动收藏闸门 ──────────────────────────────────────────────────────────
const CAPTION = { name: '委屈巴巴', tags: ['安慰', '可怜'], note: '抱抱你', meaning: '想被安慰一下', sticker: true, collect: true };

test('autoCollectStickerFromPool：各闸门短路（关闭/不值得/没含义/标签少/过期/已收）', async (t) => {
  const fresh = () => poolItem({ id: 'a', media: { kind: 'image' }, at: Date.now() });
  const cases = [
    { name: '总开关关闭', ctx: { cfg: { socialV2: { sticker: { autoCollect: { enabled: false } } } } }, target: fresh(), caption: CAPTION, reason: 'disabled' },
    { name: 'sticker=false', target: fresh(), caption: { ...CAPTION, sticker: false }, reason: 'not-worth' },
    { name: 'collect=false', target: fresh(), caption: { ...CAPTION, collect: false }, reason: 'not-worth' },
    { name: '含义太短', target: fresh(), caption: { ...CAPTION, meaning: '抱抱' }, reason: 'no-meaning' },
    { name: '标签不足 2 个', target: fresh(), caption: { ...CAPTION, tags: ['安慰'] }, reason: 'few-tags' },
    { name: '超过默认 6 小时', target: poolItem({ id: 'a', at: Date.now() - 7 * 3600 * 1000 }), caption: CAPTION, reason: 'stale' },
    { name: '已收藏', target: poolItem({ id: 'a', at: Date.now(), collected: true }), caption: CAPTION, reason: 'done' },
    { name: '已自动收藏', target: poolItem({ id: 'a', at: Date.now(), autoCollected: true }), caption: CAPTION, reason: 'done' },
  ];
  for (const c of cases) {
    const h = makePool(t, c.ctx ? { ctx: c.ctx } : {});
    assert.deepEqual(await h.pool.autoCollectStickerFromPool(c.target, c.caption), { ok: false, reason: c.reason }, c.name);
    assert.equal(h.calls.fetched.length, 0, `${c.name}：不应下载图片`);
  }
});

test('autoCollectStickerFromPool：节奏闸拒绝时把 metaPatch 落盘并原样返回 reason', async (t) => {
  const gate = { ok: false, reason: 'hour-cap', metaPatch: { autoDay: '2026-11-02', autoCount: 1, autoHourCount: 2 } };
  const h = makePool(t, { ctx: { evaluateAutoCollect: () => gate } });
  const res = await h.pool.autoCollectStickerFromPool(poolItem({ id: 'a' }), CAPTION);
  assert.deepEqual(res, { ok: false, reason: 'hour-cap' });
  assert.deepEqual(h.pool.poolMeta(), gate.metaPatch);
  assert.equal(h.calls.botRequests.length, 0);
});

test('autoCollectStickerFromPool：拿不到图片字节时返回 no-image', async (t) => {
  const h = makePool(t, { ctx: { fetchMediaData: async () => [{}, null] } });
  const res = await h.pool.autoCollectStickerFromPool(poolItem({ id: 'a' }), CAPTION);
  assert.deepEqual(res, { ok: false, reason: 'no-image' });
  assert.equal(h.calls.botRequests.length, 0);
});

// [BUG] sticker-pool-service.mjs:104 —— 模块内 `crypto.createHash` 是裸引用，而全局 crypto
// (WebCrypto) 没有 createHash（只有 node:crypto 有），必抛 TypeError。
test('autoCollectStickerFromPool：正常路径应调用 add_custom_face 并写备注', async (t) => {
  const h = makePool(t);
  writeJson(h.poolFile, [poolItem({ id: 'a', at: Date.now() })]);
  let res;
  try {
    res = await h.pool.autoCollectStickerFromPool(poolItem({ id: 'a', at: Date.now() }), CAPTION);
  } catch (error) {
    assert.fail(`正常收藏路径抛错：${error?.message ?? error}；日志：${h.calls.logs.join(' | ')}`);
  }
  assert.deepEqual(res, { ok: true, emojiId: 'EMOJI-1' }, `实际：${JSON.stringify(res)}；日志：${h.calls.logs.join(' | ')}`);
  assert.deepEqual(h.calls.botRequests.map((r) => r.action), ['add_custom_face', 'modify_custom_face']);
  assert.equal(h.calls.botRequests[0].params.file.startsWith('base64://'), true);
  assert.equal(h.calls.botRequests[1].params.emoji_id, 'EMOJI-1');
  assert.equal(h.calls.botRequests[1].params.desc, '抱抱你');
  assert.deepEqual(h.calls.syncCalls, [true], '收藏后强制刷新本地库');
  const saved = readJson(h.poolFile)[0];
  assert.equal(saved.collected, true);
  assert.equal(saved.autoCollected, true);
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker-auto] 自动收藏「委屈巴巴」')));
});

// [BUG] 同上（crypto.createHash 在去重判定之前）——修好后这条锁“已在库不重复收藏”。
test('autoCollectStickerFromPool：库里已有同 md5 的图时跳过，并把候选标记为已处理', async (t) => {
  const md5 = crypto.createHash('md5').update(Buffer.from('img-bytes')).digest('hex');
  const h = makePool(t);
  h.box.entries = [{ id: 'old', md5: md5.toUpperCase() }];
  writeJson(h.poolFile, [poolItem({ id: 'a', at: Date.now() })]);
  const target = poolItem({ id: 'a', at: Date.now() });
  let res;
  try {
    res = await h.pool.autoCollectStickerFromPool(target, CAPTION);
  } catch (error) {
    assert.fail(`去重路径抛错：${error?.message ?? error}；日志：${h.calls.logs.join(' | ')}`);
  }
  assert.deepEqual(res, { ok: false, reason: 'duplicate' });
  assert.equal(h.calls.botRequests.length, 0, '重复图不再 add_custom_face');
  const saved = readJson(h.poolFile)[0];
  assert.equal(saved.collected, true);
  assert.equal(saved.autoCollected, true);
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker-auto] 跳过重复')));
});

// ── 池内单张打标 ──────────────────────────────────────────────────────────
test('captionPoolOne：DSH 未就绪 / 表情体系关闭时 not-ready', async (t) => {
  const notReady = makePool(t, { ctx: { isDshReady: () => false } });
  assert.deepEqual(await notReady.pool.captionPoolOne(), { ok: false, reason: 'not-ready' });
  const off = makePool(t, { ctx: { stickerEnabled: () => false } });
  assert.deepEqual(await off.pool.captionPoolOne(), { ok: false, reason: 'not-ready' });
});

test('captionPoolOne：3 分钟内已打标过就节流，force 可绕过', async (t) => {
  const h = makePool(t);
  writeJson(h.metaFile, { lastCaptionAt: Date.now() - 60 * 1000 });
  writeJson(h.poolFile, [poolItem({ id: 'a' })]);
  assert.deepEqual(await h.pool.captionPoolOne(), { ok: false, reason: 'throttled' });
  const res = await h.pool.captionPoolOne({ force: true });
  assert.notEqual(res.reason, 'throttled');
});

test('captionPoolOne：池里没有可打标的（空/已有备注/已收/过期/退避跳过）', async (t) => {
  const h = makePool(t);
  assert.deepEqual(await h.pool.captionPoolOne(), { ok: false, reason: 'nothing' }, '空池');
  writeJson(h.poolFile, [
    poolItem({ id: 'done', desc: '有名字' }),
    poolItem({ id: 'collected', collected: true }),
    poolItem({ id: 'old', at: Date.now() - 8 * 24 * 3600 * 1000 }),
    poolItem({ id: 'skipped', captionSkipped: true }),
  ]);
  assert.deepEqual(await h.pool.captionPoolOne({ force: true }), { ok: false, reason: 'nothing' });
});

// [BUG] sticker-pool-service.mjs:163 —— 与 autoCollect 同源：`crypto.createHash` 裸引用。
test('captionPoolOne：成功路径应写回打标结果并清理重试字段', async (t) => {
  const h = makePool(t);
  writeJson(h.poolFile, [poolItem({ id: 'a', at: Date.now() })]);
  const res = await h.pool.captionPoolOne({ force: true });
  assert.deepEqual(res, { ok: true, desc: '委屈巴巴' }, `实际：${JSON.stringify(res)}；日志：${h.calls.logs.join(' | ')}`);
  const saved = readJson(h.poolFile)[0];
  assert.equal(saved.desc, '委屈巴巴');
  assert.deepEqual(saved.tags, ['安慰', '可怜']);
  assert.equal(saved.note, '抱抱你');
  assert.equal(saved.meaning, '想被安慰一下');
  assert.match(saved.imageHash, /^[0-9a-f]{32}$/);
  assert.equal(saved.isSticker, true);
  assert.equal(saved.collect, true);
  assert.ok(saved.captionedAt > 0);
  assert.equal('captionAttempts' in saved, false);
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker-pool] 打标：委屈巴巴')));
});

test('captionPoolOne：拿不到图片 → 记录重试信息，3 次后标记跳过', async (t) => {
  const h = makePool(t, { ctx: { fetchMediaData: async () => [] } });
  writeJson(h.poolFile, [poolItem({ id: 'a', at: Date.now() })]);
  const first = await h.pool.captionPoolOne({ force: true });
  assert.deepEqual(first, { ok: false, reason: 'no-image' });
  let saved = readJson(h.poolFile)[0];
  assert.equal(saved.captionAttempts, 1);
  assert.equal(saved.captionLastError, 'no-image');
  assert.ok(saved.captionFailedAt > 0);
  assert.equal(Boolean(saved.captionSkipped), false);

  // 第二次失败要等退避窗口过去：把 failedAt 拨回 2 小时前（指数退避此时才放行第 2 次）
  writeJson(h.poolFile, [{ ...saved, captionAttempts: 2, captionFailedAt: Date.now() - 2 * 3600 * 1000 }]);
  const third = await h.pool.captionPoolOne({ force: true });
  assert.deepEqual(third, { ok: false, reason: 'no-image' });
  saved = readJson(h.poolFile)[0];
  assert.equal(saved.captionAttempts, 3);
  assert.equal(saved.captionSkipped, true);

  const after = await h.pool.captionPoolOne({ force: true });
  assert.equal(after.reason, 'nothing', '跳过后不再选中');
});

test('captionPoolOne：依赖抛错时落盘失败现场（attempts/lastError 截断）并返回 error', async (t) => {
  const h = makePool(t, { ctx: { visionAsk: async () => { throw new Error('vision ' + 'x'.repeat(200)); } } });
  writeJson(h.poolFile, [poolItem({ id: 'a', at: Date.now() })]);
  const res = await h.pool.captionPoolOne({ force: true });
  assert.deepEqual(res, { ok: false, reason: 'error' });
  const saved = readJson(h.poolFile)[0];
  assert.equal(saved.captionAttempts, 1);
  assert.equal(saved.captionLastError.length, 120);
  assert.ok(saved.captionLastError.startsWith('vision xxx'));
  assert.ok(h.calls.logs.some((l) => l.includes('打标失败: vision')));
});

// ── 递图一行 ──────────────────────────────────────────────────────────────
test('stickerPoolLine：inject=false / 非群聊 / 不新鲜都返回空串', (t) => {
  const off = makePool(t, { ctx: { cfg: { socialV2: { sticker: { pool: { inject: false } } } } } });
  assert.equal(off.pool.stickerPoolLine('group:1'), '');
  const h = makePool(t);
  assert.equal(h.pool.stickerPoolLine('private:1'), '');
  writeJson(h.poolFile, [
    poolItem({ id: 'nod', desc: '', captionedAt: Date.now() }),
    poolItem({ id: 'shown', desc: '看过', shownAt: Date.now(), captionedAt: Date.now() }),
    poolItem({ id: 'collected', desc: '收了', collected: true, captionedAt: Date.now() }),
    poolItem({ id: 'stale', desc: '久了', captionedAt: Date.now() - 13 * 3600 * 1000 }),
    poolItem({ id: 'other', key: 'group:2', desc: '别群', captionedAt: Date.now() }),
  ]);
  assert.equal(h.pool.stickerPoolLine('group:1'), '');
});

test('stickerPoolLine：正常递最近几张 + 标记 shownAt（同一张只递一次）', (t) => {
  const h = makePool(t);
  const now = Date.now();
  writeJson(h.poolFile, [
    poolItem({ id: 'a', messageId: '1', desc: '委屈巴巴', tags: ['安慰'], sender: '群友A', captionedAt: now }),
    poolItem({ id: 'b', messageId: '2', desc: '笑到打滚', tags: [], sender: '群友B', captionedAt: now }),
    poolItem({ id: 'c', messageId: '3', desc: '摸摸头', tags: ['安慰', '摸头'], sender: '', captionedAt: now }),
  ]);
  const line = h.pool.stickerPoolLine('group:1');
  assert.match(line, /【群里最近的图】/);
  assert.match(line, /- 委屈巴巴 \[安慰\]（群友A发的，messageId=1）/);
  assert.match(line, /- 笑到打滚（群友B发的，messageId=2）/);
  assert.match(line, /- 摸摸头 \[安慰\/摸头\]（某人发的，messageId=3）/);
  assert.match(line, /qq_collect_sticker\(messageId=/);
  assert.match(line, /\n\n$/, '块尾留空行给拼接');
  const saved = readJson(h.poolFile);
  assert.ok(saved.every((x) => x.shownAt > 0), '递过的都写 shownAt');
  assert.equal(h.pool.stickerPoolLine('group:1'), '', '第二遍不再递');
  assert.ok(h.calls.logs.some((l) => l.includes('递给她 3 张候选')));
});

test('stickerPoolLine：max 只取最后几张', (t) => {
  const h = makePool(t);
  const now = Date.now();
  writeJson(h.poolFile, ['一', '二', '三', '四'].map((d, i) => poolItem({
    id: `i${i}`, messageId: String(i), desc: d, captionedAt: now,
  })));
  const line = h.pool.stickerPoolLine('group:1', 2);
  assert.match(line, /- 三/);
  assert.match(line, /- 四/);
  assert.doesNotMatch(line, /- 一/);
  const saved = readJson(h.poolFile);
  assert.deepEqual(saved.map((x) => Boolean(x.shownAt)), [false, false, true, true]);
});

test('stickerPoolLine：落盘失败也只是标记丢失，不抛且照样递', (t) => {
  const h = makePool(t, { ctx: { atomicWriteJson: () => { throw new Error('disk full'); } } });
  const now = Date.now();
  writeJson(h.poolFile, [poolItem({ id: 'a', desc: '委屈巴巴', captionedAt: now })]);
  const line = h.pool.stickerPoolLine('group:1');
  assert.match(line, /委屈巴巴/);
});

// ── 启动补同步 ────────────────────────────────────────────────────────────
test('stickerResyncAfterOpen：开关关闭 / 已同步过 / 60 秒内已尝试都不再排', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = makePool(t, { ctx: { cfg: { socialV2: { sticker: { enabled: false } } } } });
  off.pool.stickerResyncAfterOpen();
  assert.deepEqual(off.calls.resync, []);

  const synced = makePool(t, { ctx: { getStickerSyncedAt: () => Date.now() } });
  synced.pool.stickerResyncAfterOpen();
  assert.deepEqual(synced.calls.resync, []);

  const recent = makePool(t, { ctx: { getStickerResyncAt: () => Date.now() - 30 * 1000 } });
  recent.pool.stickerResyncAfterOpen();
  assert.deepEqual(recent.calls.resync, []);
  assert.deepEqual(recent.calls.syncCalls, []);
});

test('stickerResyncAfterOpen：排一次 5 秒后的强制同步，成功写日志', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makePool(t, {
    ctx: {
      syncStickerLibrary: async (force) => {
        h.calls.syncCalls.push(force);
        return { entries: [{ id: 'a' }, { id: 'b' }], fromCache: false };
      },
    },
  });
  h.pool.stickerResyncAfterOpen();
  assert.equal(h.calls.resync.length, 1);
  assert.equal(h.calls.syncCalls.length, 0, '不是立刻同步');
  t.mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls.syncCalls, [true]);
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker] 启动补同步成功：2 个收藏表情')));
});

test('stickerResyncAfterOpen：同步失败只记日志，不抛', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makePool(t, { ctx: { syncStickerLibrary: async () => { throw new Error('ws down'); } } });
  h.pool.stickerResyncAfterOpen();
  t.mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker] 启动补同步失败: ws down')));
});
