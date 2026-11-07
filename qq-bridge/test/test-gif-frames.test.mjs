// gif-frames.js 单测：GIF 识别、抽帧选择、PNG 编码与失败回退（零依赖，不碰外部文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { isGifBuffer, pngFromRgba, extractGifFrames } from '../src/domain/send/gif-frames.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 最小 GIF89a：2 色全局调色板 + 1x1 图像块。
// LZW 码流 clear(4) → 像素0(0) → eoi(5)，LSB-first 打包为 0x44 0x01。
function makeGif(frameCount = 1, { width = 1, height = 1, delay = 5 } = {}) {
  const b = [];
  b.push(...Buffer.from('GIF89a', 'ascii'));
  b.push(width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff);
  b.push(0x80, 0x00, 0x00); // 有全局表 / 2 项 / bg 0 / aspect 0
  b.push(0x00, 0x00, 0x00, 0xff, 0xff, 0xff); // 黑、白
  for (let i = 0; i < frameCount; i += 1) {
    b.push(0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00); // 图形控制扩展
    b.push(0x2c, 0x00, 0x00, 0x00, 0x00,
      width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff, 0x00); // 图像描述符
    b.push(0x02, 0x02, 0x44, 0x01, 0x00); // minCodeSize=2 + 子块(2 字节) + 终止
  }
  b.push(0x3b);
  return Buffer.from(b);
}

function pngInfo(buf) {
  assert.deepEqual(Buffer.from(buf.subarray(0, 8)), PNG_SIG, 'PNG 签名不对');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

function idatOf(buf) {
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('ascii', p + 4, p + 8) === 'IDAT') return buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
  }
  throw new Error('PNG 里没有 IDAT');
}

test('isGifBuffer：只认 GIF87a/89a，短数据与非 Buffer 拒绝', () => {
  assert.equal(isGifBuffer(makeGif(1)), true);
  assert.equal(isGifBuffer(Buffer.from('GIF87a' + 'X'.repeat(10), 'ascii')), true);
  assert.equal(isGifBuffer(Buffer.from('PNG'.padEnd(16, '.'), 'ascii')), false);
  assert.equal(isGifBuffer(Buffer.alloc(5)), false);
  assert.equal(isGifBuffer('GIF89a'), false);
  assert.equal(isGifBuffer(null), false);
});

test('pngFromRgba：写出可被解析的 RGBA PNG（尺寸/位深/颜色类型/像素）', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const png = pngFromRgba(rgba, 2, 1);
  const info = pngInfo(png);
  assert.deepEqual([info.width, info.height, info.bitDepth, info.colorType], [2, 1, 8, 6]);
  const raw = zlib.inflateSync(idatOf(png));
  assert.equal(raw.length, 9, '每行 1 字节 filter + 2px × RGBA');
  assert.equal(raw[0], 0, 'filter 应为 none');
  assert.deepEqual([...raw.subarray(1, 9)], [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('单帧 GIF：animated=false，回 1 张 PNG，延迟按 1/100s 换算', () => {
  const r = extractGifFrames(makeGif(1));
  assert.ok(r);
  assert.equal(r.animated, false);
  assert.equal(r.frameCount, 1);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].index, 0);
  assert.equal(r.frames[0].delayMs, 50);
  pngInfo(r.frames[0].png);
});

test('多帧 GIF：animated=true，默认抽 3 帧且保留顺序', () => {
  const r = extractGifFrames(makeGif(3));
  assert.equal(r.animated, true);
  assert.equal(r.frameCount, 3);
  assert.equal(r.totalDurationMs, 150);
  assert.deepEqual(r.frames.map((f) => f.index), [0, 1, 2]);
});

test('maxFrames=2：3 帧里取首尾两张', () => {
  const r = extractGifFrames(makeGif(3), { maxFrames: 2 });
  assert.deepEqual(r.frames.map((f) => f.index), [0, 2]);
});

test('10 帧取 3 张：均匀覆盖首/中/尾', () => {
  const r = extractGifFrames(makeGif(10), { maxFrames: 3 });
  assert.deepEqual(r.frames.map((f) => f.index), [0, 5, 9]);
});

test('maxDecodeFrames 截断：truncated=true，frameCount 仍是完整帧数', () => {
  const r = extractGifFrames(makeGif(3), { maxDecodeFrames: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.frameCount, 3);
  assert.equal(r.decodedFrames, 2);
});

test('超过 maxPixels：直接放弃，返回 null 交给调用方回退单帧', () => {
  assert.equal(extractGifFrames(makeGif(1, { width: 3000, height: 3000 })), null);
});

test('maxFrames=1：多帧里取中间一帧，不能因除零退化成 null', () => {
  const r = extractGifFrames(makeGif(5), { maxFrames: 1 });
  assert.ok(r, 'maxFrames=1 是合法参数，不能返回 null');
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].index, 2, '5 帧取 1 帧应取中间帧');
});

test('坏数据 / 非 GIF：返回 null 且不抛', () => {
  assert.equal(extractGifFrames(makeGif(1).subarray(0, 20)), null);
  assert.equal(extractGifFrames(makeGif(1).subarray(0, 6)), null);
  assert.equal(extractGifFrames(Buffer.from('not a gif at all')), null);
  assert.equal(extractGifFrames(Buffer.alloc(0)), null);
});
