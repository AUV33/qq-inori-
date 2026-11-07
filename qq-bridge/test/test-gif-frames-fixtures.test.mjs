// gif-frames 真实样本回归：透明背景 / disposal / 隔行 / 真实调色板 LZW。
// 用 Pillow 生成的小 GIF（base64 内嵌），补上“构造的极简 GIF 覆盖不到的编码路径”。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { extractGifFrames } from '../src/domain/send/gif-frames.js';

const TWO = 'R0lGODlhQABAAIEAANweHgAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQARgAAACwAAAAAQABAAAAIaQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izagUQEAAh+QQBRgABACwAAAAAQABAAIEeHtwAAAAAAAAAAAAIaQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izagUQEAA7';
const THREE = 'R0lGODlhUAA8AIEAAAAAAB7IHgAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJHgAAACwAAAAAUAA8AAAIuwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkxkDqFzJsqXLligdvpxJU2XMhjVzwry5UKfPADx7/swZVOFQokURHq2ZVOnSmU0PPoUateDUl1WtXt2ZVeBWrl2/suw6UOxKsl7NAkWrdi3ZtmgBwGWrNu7ct3XpmrWbF+9evWL5/vUbGPBXwYUJHza8Na7jx5AjS55MubLly5gza97MubPnz6BDix4dOiAAIfkECR4AAAAsGQAKABoAHwCBAAAAHoweAAAAAAAACDAAAwgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMaAwIAIfkECR4AAAAsLQAKABoAHwCBAAAAHlAeAAAAAAAACDAAAwgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMaAwIAOw==';
const INTERLACED = 'R0lGODlhIAAgAIEAAMjIFAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAMgAAACwAAAAAIAAgAAAINQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJUmRAACH5BAEyAAEALAAAAAAgACAAgRTIyAAAAAAAAAAAAAg1AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMlSZEAAOw==';

const buf = (b64) => Buffer.from(b64, 'base64');

function pngPixel(png, x, y) {
  let off = 8; let w = 0; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') w = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const p = y * (w * 4 + 1) + 1 + x * 4;
  return [...raw.subarray(p, p + 4)];
}

test('真实两帧 GIF：尺寸/帧数/总时长/首尾像素', () => {
  const r = extractGifFrames(buf(TWO));
  assert.ok(r);
  assert.equal(`${r.width}x${r.height}`, '64x64');
  assert.equal(r.frameCount, 2);
  assert.equal(r.totalDurationMs, 1400);
  assert.deepEqual(r.frames.map((f) => f.index), [0, 1]);
  assert.deepEqual(pngPixel(r.frames[0].png, 0, 0), [220, 30, 30, 255]);
  assert.deepEqual(pngPixel(r.frames[1].png, 0, 0), [30, 30, 220, 255]);
});

test('真实透明三帧 GIF：透明背景 + disposal=2 + 方块逐帧右移', () => {
  const r = extractGifFrames(buf(THREE));
  assert.ok(r);
  assert.equal(r.frameCount, 3);
  assert.equal(r.totalDurationMs, 900);
  assert.deepEqual(pngPixel(r.frames[0].png, 0, 0), [0, 0, 0, 0], '角上透明');
  assert.deepEqual(pngPixel(r.frames[0].png, 10, 20), [30, 200, 30, 255], '第 1 帧方块');
  assert.deepEqual(pngPixel(r.frames[2].png, 50, 20), [30, 80, 30, 255], '第 3 帧方块在右侧');
  assert.deepEqual(pngPixel(r.frames[2].png, 10, 20), [0, 0, 0, 0], '上一帧位置被 disposal 清掉');
});

test('真实隔行 GIF：行序还原正确', () => {
  const r = extractGifFrames(buf(INTERLACED));
  assert.ok(r);
  assert.equal(r.frameCount, 2);
  assert.deepEqual(pngPixel(r.frames[0].png, 0, 0), [200, 200, 20, 255]);
  assert.deepEqual(pngPixel(r.frames[0].png, 31, 31), [200, 200, 20, 255]);
  assert.deepEqual(pngPixel(r.frames[1].png, 0, 0), [20, 200, 200, 255]);
});
