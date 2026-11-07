// media-service 的金标：base64 解析、文件名白名单、本地路径边界、媒体列表上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaService } from '../src/domain/send/media-service.mjs';

function ctx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-'));
  const home = path.join(dir, 'snowluma');
  fs.mkdirSync(home, { recursive: true });
  const calls = { ask: [], fetch: [] };
  const base = {
    fs, path,
    cfg: { snowluma: { homeDir: home } },
    log: () => {},
    getBot: () => ({
      getImage: async () => ({ data: Buffer.from('img').toString('base64') }),
      fetchFaceEntity: async () => ({ q_des: '笑脸' }),
    }),
    vision: { ask: async (...args) => { calls.ask.push(args); return 'vision-answer'; } },
    getImageDimensions: () => ({ width: 10, height: 10 }),
    looksLikeImageBuffer: () => true,
    mimeFromBuffer: () => 'image/png',
    mimeFromUrl: () => 'image/jpeg',
    safeFetchBuffer: async (url) => { calls.fetch.push(url); return { buffer: Buffer.from('img') }; },
  };
  Object.assign(base, overrides);
  return { svc: createMediaService(base), dir, home, calls };
}

test('base64FromMaybe：base64://、data:image、纯 base64、非法', () => {
  const h = ctx();
  assert.equal(h.svc.base64FromMaybe('base64://aGVsbG8='), 'aGVsbG8=');
  assert.equal(h.svc.base64FromMaybe('data:image/png;base64,aGVsbG8='), 'aGVsbG8=');
  assert.equal(h.svc.base64FromMaybe('aGVs bG8='), 'aGVsbG8=');
  assert.equal(h.svc.base64FromMaybe('not base64!'), null);
  assert.equal(h.svc.base64FromMaybe(''), null);
  assert.equal(h.svc.base64FromMaybe(null), null);
});

test('isProbablySafeImageFileRef：只接受简单缓存文件名', () => {
  const h = ctx();
  for (const ok of ['abc.jpg', 'a+b=c.png', 'file@2x.webp', 'x-1_2.3']) assert.equal(h.svc.isProbablySafeImageFileRef(ok), true, ok);
  for (const bad of ['', '../a', 'a/b', 'a\\b', 'C:file', 'https://x', 'file://x', 'data:image/png', 'a b', 'x\u0000']) assert.equal(h.svc.isProbablySafeImageFileRef(bad), false, bad);
});

test('isSafeLocalMediaPath：只允许 snowluma home 内', () => {
  const h = ctx();
  const inside = path.join(h.home, 'a.png');
  const outside = path.join(h.dir, 'b.png');
  fs.writeFileSync(inside, 'x');
  fs.writeFileSync(outside, 'x');
  assert.equal(h.svc.isSafeLocalMediaPath(inside), true);
  assert.equal(h.svc.isSafeLocalMediaPath(outside), false);
  assert.equal(h.svc.isSafeLocalMediaPath(path.join(h.home, 'missing.png')), false);
});

test('fetchOneBotImage：get_image base64 成功', async () => {
  const h = ctx();
  const r = await h.svc.fetchOneBotImage({ kind: 'image', file: 'a.jpg' });
  assert.equal(r.mimeType, 'image/png');
  assert.equal(Buffer.isBuffer(r.buffer), true);
});

test('resolveMediaList：超过 5 条跳过；表情/图片失败给文字', async () => {
  const h = ctx();
  const list = Array.from({ length: 6 }, (_, i) => ({ kind: 'image', file: `a${i}.jpg` }));
  const parts = await h.svc.resolveMediaList(list);
  const texts = parts.filter((p) => p.type === 'text').map((p) => p.text);
  assert.ok(texts.some((t) => t.includes('超过单条上限')));
  assert.equal(parts.filter((p) => p.type === 'image').length, 5);

  const fail = ctx({ getBot: () => ({ getImage: async () => ({}), fetchFaceEntity: async () => ({}) }) });
  const out = await fail.svc.resolveMediaList([{ kind: 'image', file: 'a.jpg' }, { kind: 'face', faceId: 1 }]);
  assert.deepEqual(out.map((p) => p.type), ['text', 'text']);
  assert.match(out[0].text, /获取失败/);
  assert.match(out[1].text, /表情#1/);
});

test('fetchMediaData：结构带 index/kind，失败也给条目', async () => {
  const h = ctx();
  const out = await h.svc.fetchMediaData([{ kind: 'image', file: 'a.jpg' }, { kind: 'face', faceId: 2 }]);
  assert.equal(out[0].index, 1);
  assert.equal(out[0].kind, 'image');
  assert.equal(out[0].mimeType, 'image/png');
  assert.equal(out[1].kind, 'face');
  assert.equal(out[1].faceId, '2');
  assert.equal(out[1].text, '[表情:笑脸]');
});

test('visionAsk：原样转发给 vision.ask', async () => {
  const h = ctx();
  const r = await h.svc.visionAsk(['b64'], '这是什么', 'image/jpeg', 1234);
  assert.equal(r, 'vision-answer');
  assert.deepEqual(h.calls.ask[0], [['b64'], '这是什么', { mimeType: 'image/jpeg', timeoutMs: 1234 }]);
});

// 两帧 64x64 GIF（红 → 蓝，各 700ms），验证动图抽帧接入。
const GIF_TWO = 'R0lGODlhQABAAIEAANweHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQARgAAACwAAAAAQABAAAAIaQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izagUQEAAh+QQBRgABACwAAAAAQABAAIEeHtwAAAAAAAAAAAAIaQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izagUQEAA7';

test('resolveMediaList：GIF 动图抽 2 帧 PNG，并在文字里说明“抽了几帧”', async () => {
  const h = ctx({
    getBot: () => ({ getImage: async () => ({ data: 'base64://' + GIF_TWO }) }),
    mimeFromBuffer: () => 'image/gif',
  });
  const parts = await h.svc.resolveMediaList([{ kind: 'image', file: 'a.gif' }]);
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  assert.match(text, /动图/);
  assert.match(text, /抽了 2 帧/);
  const images = parts.filter((p) => p.type === 'image');
  assert.equal(images.length, 2);
  assert.equal(images[0].mediaType, 'image/png');
  assert.match(images[0].name, /f1\.png$/);
});

test('fetchMediaData：GIF 保留原图 data（收藏用），另带 frames（看图用）', async () => {
  const h = ctx({
    getBot: () => ({ getImage: async () => ({ data: 'base64://' + GIF_TWO }) }),
    mimeFromBuffer: () => 'image/gif',
  });
  const out = await h.svc.fetchMediaData([{ kind: 'image', file: 'a.gif' }]);
  assert.equal(out[0].mimeType, 'image/gif');
  assert.equal(Buffer.from(out[0].data, 'base64').toString('ascii', 0, 3), 'GIF', 'data 必须是原 GIF，别拿 PNG 覆盖');
  assert.equal(out[0].animated, true);
  assert.equal(out[0].frameCount, 2);
  assert.equal(out[0].frames.length, 2);
  assert.equal(out[0].frames[0].mimeType, 'image/png');
});

test('visionAsk：GIF 单图自动抽帧，多帧按 PNG 传给 vision.ask', async () => {
  const h = ctx();
  await h.svc.visionAsk([GIF_TWO], '图里有什么变化', 'image/gif', 1000);
  const [images, question, opts] = h.calls.ask[0];
  assert.equal(images.length, 2);
  assert.equal(opts.mimeType, 'image/png');
  assert.equal(question, '图里有什么变化');
});

test('resolveMediaList：多条 GIF 时图片总数封顶 5，超出给文字而不是无限膨胀', async () => {
  const h = ctx({
    getBot: () => ({ getImage: async () => ({ data: 'base64://' + GIF_TWO }) }),
    mimeFromBuffer: () => 'image/gif',
  });
  const parts = await h.svc.resolveMediaList(Array.from({ length: 5 }, () => ({ kind: 'image', file: 'a.gif' })));
  assert.equal(parts.filter((p) => p.type === 'image').length, 5);
  assert.ok(parts.some((p) => p.type === 'text' && /数量已达上限/.test(p.text)));
});
