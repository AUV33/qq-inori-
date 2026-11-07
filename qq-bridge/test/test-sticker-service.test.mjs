// sticker-service 金标：收藏表情同步（TTL/条数上限/坏数据不清库）、取图、发送（收藏表情/图片段/引用/@）、
// 备注/收藏聊天表情、本地库降级只读。
//
// 全部依赖注入：不发网络、不读仓库 state/。sticker-lib 的纯函数（findSticker/applyStickerNote/
// markStickerUsed）用真实实现，服务层只替换 IO 与 OneBot。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStickerService } from '../src/domain/social/sticker-service.mjs';
import { findSticker, applyStickerNote, markStickerUsed } from '../src/domain/send/sticker-lib.js';

const MD5 = 'A'.repeat(32);

function okFetch(data = { message_id: 555 }) {
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) };
}

function makeService(opts = {}) {
  const calls = {
    logs: [],
    saves: [],
    requests: [],
    merges: [],
    safeFetches: [],
    http: [],
    order: [],
    guards: [],
    imageFetches: [],
    faceFetches: [],
    enqueued: 0,
    sleeps: [],
  };
  const box = { entries: (opts.entries ?? []).map((e) => ({ ...e })) };
  const bot = {
    request: async (action, params) => {
      calls.requests.push({ action, params });
      const resp = opts.botResponses?.[action];
      if (resp instanceof Error) throw resp;
      return resp ?? { status: 'ok', retcode: 0, data: action === 'fetch_custom_face_detail' ? [] : { emoji_id: 'EMOJI-1' } };
    },
  };
  const outgoing = {
    enqueue(fn) {
      calls.enqueued += 1;
      calls.order.push('enqueue');
      if (opts.queueOnly) { calls.pending = fn; return undefined; }
      return fn();
    },
  };
  const ctx = {
    cfg: opts.cfg ?? {
      snowluma: { httpUrl: 'http://bot.test:3000/', accessToken: 'TKN' },
      socialV2: { sticker: { enabled: true, syncTtlMs: 60000, maxListCount: 100 } },
    },
    getBot: () => bot,
    log: (...args) => { calls.logs.push(args.map((a) => String(a)).join(' ')); },
    stickerFile: '/state/stickers.json',
    loadStickerStore: () => {
      if (opts.loadThrows) throw new Error('库损坏');
      return box.entries;
    },
    saveStickerStore: (file, entries) => {
      calls.saves.push({ file, entries });
      box.entries = entries;
    },
    mergeStickerLibrary: (cur, fetched, mergeOpts) => {
      calls.merges.push({ cur, fetched, opts: mergeOpts });
      return opts.mergedEntries ?? cur;
    },
    findSticker,
    markStickerUsed: (entries, id, context) => {
      calls.order.push('markStickerUsed');
      return markStickerUsed(entries, id, context);
    },
    applyStickerNote,
    captureSendGuard: (key) => {
      calls.guards.push(key);
      return () => { calls.order.push('guard'); if (opts.guardThrows) throw new Error('发送被拒绝'); };
    },
    safeFetchBuffer: async (url) => {
      calls.safeFetches.push(url);
      calls.order.push('safeFetchBuffer');
      if (opts.safeFetchThrows) throw new Error('地址不合法');
      return { buffer: Buffer.from('IMG-BYTES') };
    },
    getOutgoing: () => outgoing,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      calls.order.push('sleep');
    },
    randInt: (min, max) => { calls.rand = [min, max]; return min; },
    fetch: async (url, init) => {
      calls.http.push({ url, init });
      calls.order.push('http');
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      return okFetch();
    },
    oneBotError: (action, res, body) => `oneBot ${action} failed (${res?.ok}/${body?.status}/${body?.retcode})`,
    getSocialV2State: (key) => {
      const st = opts.socialStates?.[key] ?? opts.socialState ?? { recentMessages: [] };
      return st;
    },
    fetchOneBotImage: async (media) => {
      calls.imageFetches.push(media);
      return opts.imageResult === undefined ? { buffer: Buffer.from('CHAT-IMG') } : opts.imageResult;
    },
    fetchFaceMedia: async (media) => {
      calls.faceFetches.push(media);
      return opts.faceResult === undefined ? { buffer: Buffer.from('FACE-IMG') } : opts.faceResult;
    },
  };
  const svc = createStickerService({ ...ctx, ...(opts.overrides ?? {}) });
  return { svc, calls, box, bot, outgoing };
}

const groupEntry = (over = {}) => ({
  id: 'EMOJI-1',
  md5: MD5,
  url: 'https://example.test/face.png',
  desc: '委屈巴巴',
  ...over,
});

// ── 构造 / 开关 ───────────────────────────────────────────────────────────
test('构造：正常读库；stickerEnabled 缺省开、显式 false 关', () => {
  const h = makeService({ entries: [{ id: 'a' }] });
  assert.deepEqual(h.svc.getEntries().map((e) => e.id), ['a']);
  assert.equal(h.svc.stickerEnabled(), true);

  const off = makeService({ cfg: { socialV2: { sticker: { enabled: false } } } });
  assert.equal(off.svc.stickerEnabled(), false);
});

test('构造：表情库读失败降级「只读不写」，绝不回写覆盖原文件', () => {
  const h = makeService({ loadThrows: true, entries: [{ id: 'a' }] });
  assert.deepEqual(h.svc.getEntries(), [], '读失败时不动原文件，库按空处理');
  assert.ok(h.calls.logs.some((l) => l.includes('已降级为「只读不写」')));
  h.svc.saveStickerStoreSafe();
  assert.equal(h.calls.saves.length, 0);
  const entry = h.svc.applyStickerNoteV2('a', '备注');
  assert.equal(entry, null, '空库找不到 id');
  assert.equal(h.calls.saves.length, 0);
});

// ── 同步 ──────────────────────────────────────────────────────────────────
test('syncStickerLibrary：表情体系关闭时直接返回 null，不请求 OneBot', async () => {
  const h = makeService({ cfg: { socialV2: { sticker: { enabled: false } } } });
  assert.equal(await h.svc.syncStickerLibrary(true), null);
  assert.equal(h.calls.requests.length, 0);
});

test('syncStickerLibrary：成功路径合并 + 落盘 + 记录同步时间', async () => {
  const h = makeService({ entries: [{ id: 'old' }] });
  h.bot.request = async (action, params) => {
    h.calls.requests.push({ action, params });
    return { status: 'ok', retcode: 0, data: [{ emoji_id: 'a' }, { emoji_id: 'b' }] };
  };
  const res = await h.svc.syncStickerLibrary(true);
  assert.equal(res.fromCache, false);
  assert.ok(res.syncedAt > 0);
  assert.equal(h.svc.getSyncedAt(), res.syncedAt);
  assert.deepEqual(h.calls.requests[0], { action: 'fetch_custom_face_detail', params: { count: 100 } });
  assert.equal(h.calls.merges.length, 1);
  assert.deepEqual(h.calls.merges[0].fetched, [{ emoji_id: 'a' }, { emoji_id: 'b' }]);
  assert.deepEqual(h.calls.merges[0].opts, { complete: true }, '2 条 < count 视为完整结果');
  assert.equal(h.calls.saves.length, 1);
  assert.ok(h.calls.logs.some((l) => l.includes('[sticker] 已同步 QQ 收藏表情 2 个')));
});

test('syncStickerLibrary：TTL 内走缓存，force 才重拉', async () => {
  const h = makeService({ entries: [{ id: 'a' }] });
  await h.svc.syncStickerLibrary();
  await h.svc.syncStickerLibrary();
  assert.equal(h.calls.requests.length, 1, '第二次命中 TTL 缓存');
  const cached = await h.svc.syncStickerLibrary();
  assert.equal(cached.fromCache, true);
  assert.equal(cached.entries, h.svc.getEntries());
  await h.svc.syncStickerLibrary(true);
  assert.equal(h.calls.requests.length, 2, 'force 绕过缓存');
});

test('syncStickerLibrary：同步条数收敛到 1~500', async () => {
  const cases = [[999, 500], [0, 100], [-3, 1], [7, 7]];
  for (const [configured, expected] of cases) {
    const h = makeService({ cfg: { socialV2: { sticker: { maxListCount: configured } } } });
    await h.svc.syncStickerLibrary(true);
    assert.equal(h.calls.requests[0].params.count, expected, `maxListCount=${configured}`);
  }
});

test('syncStickerLibrary：部分结果（条数等于上限）标记 complete=false', async () => {
  const h = makeService({ cfg: { socialV2: { sticker: { maxListCount: 2 } } } });
  h.bot.request = async (action, params) => {
    h.calls.requests.push({ action, params });
    return { status: 'ok', retcode: 0, data: [{ emoji_id: 'a' }, { emoji_id: 'b' }] };
  };
  await h.svc.syncStickerLibrary(true);
  assert.deepEqual(h.calls.merges[0].opts, { complete: false });
});

test('syncStickerLibrary：接口失败 / data 非数组都返回 null 且不清本地库', async () => {
  const failed = makeService({ entries: [{ id: 'keep' }] });
  failed.bot.request = async (action) => {
    failed.calls.requests.push({ action });
    return { status: 'failed', retcode: 100, wording: '没权限' };
  };
  assert.equal(await failed.svc.syncStickerLibrary(true), null);
  assert.deepEqual(failed.svc.getEntries().map((e) => e.id), ['keep']);
  assert.ok(failed.calls.logs.some((l) => l.includes('同步收藏表情失败: fetch_custom_face_detail 失败: 没权限')));

  const badData = makeService({ entries: [{ id: 'keep' }] });
  badData.bot.request = async (action) => {
    badData.calls.requests.push({ action });
    return { status: 'ok', retcode: 0, data: { not: 'array' } };
  };
  assert.equal(await badData.svc.syncStickerLibrary(true), null);
  assert.deepEqual(badData.svc.getEntries().map((e) => e.id), ['keep']);
  assert.equal(badData.calls.merges.length, 0, '没有把异常数据交给 merge');
  assert.ok(badData.calls.logs.some((l) => l.includes('不是数组，已放弃同步')));
});

test('syncStickerLibrary：merge 抛错也只记日志并返回 null', async () => {
  const h = makeService({
    overrides: {
      mergeStickerLibrary: () => { throw new Error('merge boom'); },
    },
  });
  assert.equal(await h.svc.syncStickerLibrary(true), null);
  assert.ok(h.calls.logs.some((l) => l.includes('同步收藏表情失败: merge boom')));
});

test('syncStickerLibrary：syncTtlMs 非法回落 60 秒，0 表示每次都刷新', async () => {
  const invalid = makeService({ cfg: { socialV2: { sticker: { syncTtlMs: 'abc' } } } });
  await invalid.svc.syncStickerLibrary();
  await invalid.svc.syncStickerLibrary();
  assert.equal(invalid.calls.requests.length, 1, '非法值走默认 60s 缓存');

  const zero = makeService({ cfg: { socialV2: { sticker: { syncTtlMs: 0 } } } });
  await zero.svc.syncStickerLibrary();
  await zero.svc.syncStickerLibrary();
  assert.equal(zero.calls.requests.length, 2, '0 = 不缓存');
});

// ── 取图 ──────────────────────────────────────────────────────────────────
test('getStickerImageData：缓存命中不缺图；本地没有时强制刷新再找', async () => {
  const hit = makeService({ entries: [{ id: 'a' }] });
  assert.deepEqual(await hit.svc.getStickerImageData('a'), { id: 'a' });
  assert.equal(hit.calls.requests.length, 1, '只做了普通同步（TTL 内缓存）');

  const miss = makeService();
  miss.bot.request = async (action, params) => {
    miss.calls.requests.push({ action, params });
    return { status: 'ok', retcode: 0, data: [] };
  };
  // 第一次普通同步找不到 → 强制刷新后仍找不到 → 抛错
  await assert.rejects(() => miss.svc.getStickerImageData('missing'), /找不到表情 missing.*qq_list_stickers/);
  assert.equal(miss.calls.requests.length, 2, '普通同步 + 强制刷新各一次');
});

test('getStickerImageData：强制刷新后能找到新收藏', async () => {
  let round = 0;
  const h = makeService({
    overrides: {
      mergeStickerLibrary: (cur) => {
        round += 1;
        return round >= 2 ? [...cur, { id: 'fresh' }] : cur;
      },
    },
  });
  const entry = await h.svc.getStickerImageData('fresh');
  assert.deepEqual(entry, { id: 'fresh' });
  assert.equal(h.calls.requests.length, 2, '普通同步未命中 → 强制刷新命中');
});

// ── 发送 ──────────────────────────────────────────────────────────────────
test('sendStickerV2：收藏表情走 send_custom_face，带引用/授权头/群号', async () => {
  const h = makeService({ entries: [groupEntry()] });
  const res = await h.svc.sendStickerV2('group:42', 'EMOJI-1', { replyToMessageId: '123' });
  assert.deepEqual(res, { entry: h.svc.getEntries()[0], messageId: 555 });
  assert.equal(h.calls.enqueued, 1);
  assert.ok(h.calls.order.indexOf('sleep') < h.calls.order.indexOf('guard'));
  assert.ok(h.calls.order.indexOf('guard') < h.calls.order.indexOf('http'), '先过发送闸门再发');
  assert.deepEqual(h.calls.sleeps, [800]);
  assert.deepEqual(h.calls.rand, [800, 2000]);
  assert.equal(h.calls.http.length, 1);
  const { url, init } = h.calls.http[0];
  assert.equal(url, 'http://bot.test:3000/send_custom_face', '尾斜杠已去掉');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.authorization, 'Bearer TKN');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { emoji_id: MD5, group_id: 42, reply_to: '123' });
  assert.equal(h.svc.getEntries()[0].useCount, 1, '发送成功更新使用统计');
  assert.equal(h.svc.getEntries()[0].lastContext, 'sticker', '默认语境');
  assert.deepEqual(h.calls.saves.at(-1).entries, h.svc.getEntries());
  assert.deepEqual(h.calls.guards, ['group:42']);
});

test('sendStickerV2：私聊 + 自定义 context（截 100 字）', async () => {
  const h = makeService({ entries: [groupEntry()] });
  const context = '前'.repeat(150);
  await h.svc.sendStickerV2('private:7', 'EMOJI-1', { context });
  const body = JSON.parse(h.calls.http[0].init.body);
  assert.deepEqual(body, { emoji_id: MD5, user_id: 7 });
  assert.equal(h.svc.getEntries()[0].lastContext.length, 100);
});

test('sendStickerV2：没有 32 位 md5 时退回图片段（sub_type/summary 保留表情样式）', async () => {
  const h = makeService({ entries: [groupEntry({ md5: '' })] });
  await h.svc.sendStickerV2('group:42', 'EMOJI-1', { replyToMessageId: '-9', atUserId: '10001' });
  assert.deepEqual(h.calls.safeFetches, ['https://example.test/face.png']);
  assert.equal(h.calls.http[0].url, 'http://bot.test:3000/send_group_msg');
  const body = JSON.parse(h.calls.http[0].init.body);
  assert.equal(body.group_id, 42);
  assert.deepEqual(body.message[0], { type: 'reply', data: { id: '-9' } });
  assert.deepEqual(body.message[1], { type: 'at', data: { qq: '10001' } });
  assert.equal(body.message[2].type, 'image');
  assert.equal(body.message[2].data.file, 'base64://' + Buffer.from('IMG-BYTES').toString('base64'));
  assert.equal(body.message[2].data.sub_type, 1);
  assert.equal(body.message[2].data.summary, '[动画表情]');
});

test('sendStickerV2：私聊图片段走 send_private_msg；空 atUserId 不影响收藏表情路径', async () => {
  const h = makeService({ entries: [groupEntry({ md5: '' })] });
  await h.svc.sendStickerV2('private:7', 'EMOJI-1');
  assert.equal(h.calls.http[0].url, 'http://bot.test:3000/send_private_msg');
  assert.equal(JSON.parse(h.calls.http[0].init.body).user_id, 7);

  const face = makeService({ entries: [groupEntry()] });
  await face.svc.sendStickerV2('group:42', 'EMOJI-1', { atUserId: '' });
  assert.equal(face.calls.http[0].url, 'http://bot.test:3000/send_custom_face');
});

test('sendStickerV2：非法 replyToMessageId / atUserId 在入队前抛出', async () => {
  const h = makeService({ entries: [groupEntry()] });
  for (const bad of ['abc', '0', '1.5']) {
    await assert.rejects(() => h.svc.sendStickerV2('group:42', 'EMOJI-1', { replyToMessageId: bad }), /replyToMessageId 必须是非零整数/, JSON.stringify(bad));
  }
  for (const bad of ['all', '12a', '-3']) {
    await assert.rejects(() => h.svc.sendStickerV2('group:42', 'EMOJI-1', { atUserId: bad }), /atUserId 必须是正整数 QQ 号/, bad);
  }
  assert.equal(h.calls.enqueued, 0, '参数不合法就不入发送队列');
});

test('sendStickerV2：空白 replyToMessageId 视为没传（不产生引用段）', async () => {
  const h = makeService({ entries: [groupEntry()] });
  await h.svc.sendStickerV2('group:42', 'EMOJI-1', { replyToMessageId: '   ' });
  const body = JSON.parse(h.calls.http[0].init.body);
  assert.equal('reply_to' in body, false);
});

test('sendStickerV2：找不到表情 / 没有图片地址都拒绝发送', async () => {
  const missing = makeService();
  await assert.rejects(() => missing.svc.sendStickerV2('group:42', 'nope'), /找不到表情 nope.*qq_list_stickers/);
  assert.equal(missing.calls.enqueued, 0);

  const noUrl = makeService({ entries: [groupEntry({ url: '' })] });
  await assert.rejects(() => noUrl.svc.sendStickerV2('group:42', 'EMOJI-1'), /没有可发送的图片地址/);
});

test('sendStickerV2：图片下载失败 → 拒绝发送（错误带表情 id）', async () => {
  const h = makeService({ entries: [groupEntry({ md5: '' })], safeFetchThrows: true });
  await assert.rejects(() => h.svc.sendStickerV2('group:42', 'EMOJI-1'), /表情 EMOJI-1 的图片地址不合法，已拒绝发送：地址不合法/);
  assert.equal(h.calls.http.length, 0);
});

test('sendStickerV2：发送闸门抛错 → 队列内失败，不发 HTTP、不记统计', async () => {
  const h = makeService({ entries: [groupEntry()], guardThrows: true });
  await assert.rejects(() => h.svc.sendStickerV2('group:42', 'EMOJI-1'), /发送被拒绝/);
  assert.equal(h.calls.http.length, 0);
  assert.equal(h.svc.getEntries()[0].useCount || 0, 0);
});

test('sendStickerV2：OneBot 返回失败 → 抛 oneBotError 文案，不记统计', async () => {
  const h = makeService({
    entries: [groupEntry()],
    fetchImpl: async () => ({ ok: false, json: async () => ({ status: 'failed', retcode: 100, wording: '没权限' }) }),
  });
  await assert.rejects(() => h.svc.sendStickerV2('group:42', 'EMOJI-1'), /oneBot send_custom_face failed/);
  assert.equal(h.svc.getEntries()[0].useCount || 0, 0);
  assert.equal(h.svc.getEntries()[0].lastContext || '', '');
});

// ── 本地备注 ──────────────────────────────────────────────────────────────
test('applyStickerNoteV2：note/tags/usage 写入并落盘；标签串按逗号/空白拆', () => {
  const h = makeService({ entries: [groupEntry()] });
  const entry = h.svc.applyStickerNoteV2('EMOJI-1', '她的备注', '安慰, 可怜　无语', '被安慰时');
  assert.equal(entry.localNote, '她的备注');
  assert.deepEqual(entry.tags, ['安慰', '可怜', '无语']);
  assert.equal(entry.usage, '被安慰时');
  assert.equal(h.calls.saves.length, 1);
  assert.deepEqual(h.calls.saves[0].entries, h.svc.getEntries());
});

test('applyStickerNoteV2：数组标签原样 String 化；找不到 id 返回 null 且不落盘', () => {
  const h = makeService({ entries: [groupEntry()] });
  const entry = h.svc.applyStickerNoteV2('EMOJI-1', undefined, ['a', 2]);
  assert.deepEqual(entry.tags, ['a', '2']);
  assert.equal(h.svc.applyStickerNoteV2('missing', 'x'), null);
  assert.equal(h.calls.saves.length, 1, '只有成功那次落盘');
});

// ── 改 QQ 收藏备注 ────────────────────────────────────────────────────────
test('setStickerRemarkV2：改远端备注 + 本地 desc（截 50 字）并落盘', async () => {
  const h = makeService({ entries: [groupEntry()] });
  const long = '  ' + '备'.repeat(80) + '  ';
  const entry = await h.svc.setStickerRemarkV2('EMOJI-1', long);
  const modify = h.calls.requests.find((r) => r.action === 'modify_custom_face');
  assert.equal(modify.params.emoji_id, 'EMOJI-1');
  assert.equal(modify.params.desc.length, 50);
  assert.equal(entry.desc, '备'.repeat(50));
  assert.match(entry.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(h.calls.saves.at(-1).entries, h.svc.getEntries());
});

test('setStickerRemarkV2：找不到表情 / OneBot 失败都抛错', async () => {
  const missing = makeService();
  await assert.rejects(() => missing.svc.setStickerRemarkV2('nope', 'x'), /找不到表情 nope/);

  const failed = makeService({ entries: [groupEntry()] });
  failed.bot.request = async (action, params) => {
    failed.calls.requests.push({ action, params });
    if (action === 'modify_custom_face') return { status: 'failed', retcode: 9, wording: '被限制' };
    return { status: 'ok', retcode: 0, data: [] };
  };
  await assert.rejects(() => failed.svc.setStickerRemarkV2('EMOJI-1', 'x'), /modify_custom_face 失败: 被限制/);
});

// ── 收藏聊天表情 ──────────────────────────────────────────────────────────
test('collectStickerV2：图片消息 → 字节转 base64 收藏 + 按配置截断备注 + 强制刷新', async () => {
  const h = makeService({
    entries: [groupEntry()],
    cfg: {
      snowluma: { httpUrl: 'http://bot.test:3000' },
      socialV2: { sticker: { collect: { maxRemarkChars: 5 } } },
    },
    socialState: {
      recentMessages: [
        { seq: 10, messageId: 'm10', media: [{ kind: 'image', url: 'https://example.test/chat.png' }], isSelf: false },
      ],
    },
  });
  const res = await h.svc.collectStickerV2('group:42', 10, '好可爱的一张表情');
  assert.deepEqual(h.calls.imageFetches, [{ kind: 'image', url: 'https://example.test/chat.png' }], '绝不把原始 URL 交给 OneBot');
  const add = h.calls.requests.find((r) => r.action === 'add_custom_face');
  assert.equal(add.params.file, 'base64://' + Buffer.from('CHAT-IMG').toString('base64'));
  const modify = h.calls.requests.find((r) => r.action === 'modify_custom_face');
  assert.equal(modify.params.emoji_id, 'EMOJI-1');
  assert.equal(modify.params.desc, '好可爱的一');
  assert.deepEqual(res, { emojiId: 'EMOJI-1', entry: h.svc.getEntries()[0], remark: '好可爱的一' });
  assert.deepEqual(h.calls.guards, ['group:42'], '发送闸门按会话取一次');
  assert.equal(h.calls.order.filter((x) => x === 'guard').length, 2, '收藏 + 改备注各过一次闸门');
});

test('collectStickerV2：按 messageId 匹配；表情消息走 fetchFaceMedia', async () => {
  const h = makeService({
    entries: [groupEntry()],
    socialState: {
      recentMessages: [
        { seq: 10, messageId: 'm10', media: [{ kind: 'face', file: 'f1' }], isSelf: false },
      ],
    },
  });
  const res = await h.svc.collectStickerV2('group:42', 'm10', '摸摸头');
  assert.deepEqual(h.calls.faceFetches, [{ kind: 'face', file: 'f1' }]);
  assert.equal(res.remark, '摸摸头');
});

test('collectStickerV2：找不到消息 / 自己发的 / 没有媒体都抛错', async () => {
  const h = makeService({
    socialState: {
      recentMessages: [
        { seq: 1, media: [{ kind: 'image' }], isSelf: true },
        { seq: 2, isSelf: false },
      ],
    },
  });
  await assert.rejects(() => h.svc.collectStickerV2('group:42', 999, 'x'), /找不到这条消息/);
  await assert.rejects(() => h.svc.collectStickerV2('group:42', 1, 'x'), /不能收藏自己发的表情/);
  await assert.rejects(() => h.svc.collectStickerV2('group:42', 2, 'x'), /这条消息没有可收藏的图片\/表情/);
});

test('collectStickerV2：图片取不到字节 / 表情取不到 buffer / 未知 kind 都拒绝', async () => {
  const noImg = makeService({
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'image' }], isSelf: false }] },
    imageResult: null,
  });
  await assert.rejects(() => noImg.svc.collectStickerV2('group:42', 1, 'x'), /无法安全获取该图片字节，已拒绝收藏/);
  assert.equal(noImg.calls.requests.filter((r) => r.action === 'add_custom_face').length, 0);

  const noFace = makeService({
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'face', file: 'f' }], isSelf: false }] },
    faceResult: null,
  });
  await assert.rejects(() => noFace.svc.collectStickerV2('group:42', 1, 'x'), /无法获取该表情的图片源/);

  const unknown = makeService({
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'video' }], isSelf: false }] },
  });
  await assert.rejects(() => unknown.svc.collectStickerV2('group:42', 1, 'x'), /无法获取该表情的图片源/);
});

test('collectStickerV2：add_custom_face 失败 / 没 emoji_id 都抛错', async () => {
  const fail = makeService({
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'image' }], isSelf: false }] },
    botResponses: { add_custom_face: { status: 'failed', retcode: 5, wording: '收藏满了' } },
  });
  await assert.rejects(() => fail.svc.collectStickerV2('group:42', 1), /add_custom_face 失败: 收藏满了/);

  const noId = makeService({
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'image' }], isSelf: false }] },
    botResponses: { add_custom_face: { status: 'ok', retcode: 0, data: {} } },
  });
  await assert.rejects(() => noId.svc.collectStickerV2('group:42', 1), /add_custom_face 未返回 emoji_id/);
});

test('collectStickerV2：备注失败只记日志，收藏本身仍成功；空备注不回写', async () => {
  const failedRemark = makeService({
    entries: [groupEntry()],
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'image' }], isSelf: false }] },
    botResponses: {
      add_custom_face: { status: 'ok', retcode: 0, data: { emoji_id: 'EMOJI-1' } },
      modify_custom_face: { status: 'failed', retcode: 3, wording: 'desc too long' },
    },
  });
  const res = await failedRemark.svc.collectStickerV2('group:42', 1, '备注');
  assert.equal(res.emojiId, 'EMOJI-1');
  assert.ok(failedRemark.calls.logs.some((l) => l.includes('收藏成功但备注失败 EMOJI-1: desc too long')));

  const noRemark = makeService({
    entries: [groupEntry()],
    socialState: { recentMessages: [{ seq: 1, media: [{ kind: 'image' }], isSelf: false }] },
  });
  const r2 = await noRemark.svc.collectStickerV2('group:42', 1, '   ');
  assert.equal(r2.remark, '');
  assert.equal(noRemark.calls.requests.filter((r) => r.action === 'modify_custom_face').length, 0);
});

// ── 状态读写 ──────────────────────────────────────────────────────────────
test('getEntries/setEntries/getSyncedAt：外部可替换库与读取同步时间', async () => {
  const h = makeService({ entries: [{ id: 'a' }] });
  h.svc.setEntries([{ id: 'replaced' }]);
  assert.deepEqual(h.svc.getEntries().map((e) => e.id), ['replaced']);
  assert.equal(h.svc.getSyncedAt(), 0);
  await h.svc.syncStickerLibrary(true);
  assert.ok(h.svc.getSyncedAt() > 0);
});
