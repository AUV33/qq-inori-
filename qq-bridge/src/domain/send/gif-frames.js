// gif-frames.js · 把 GIF 动图解码成若干张 PNG 关键帧（无外部依赖）。
//
// 为什么自己写：这台机器没有 ffmpeg（PATH 里没有），桥接也没有 sharp；
// 但“动图只读第一帧”会让模型误判表情/动作。GIF 的 LZW 解码 + PNG 编码都不大，
// 自己实现可以保持零依赖、可单测、失败时明确回退（调用方拿 null 就按单帧处理）。
//
// 不做的事：不做缩放/裁剪之外的图像处理；不保留原动画（QQ 里怎么动由客户端决定）；
// 帧数/像素/解码帧数都有硬上限，超了返回 truncated 让调用方知道只抽了前一段。
import zlib from 'node:zlib';

const MAX_PIXELS_DEFAULT = 8_000_000;

export function isGifBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 13) return false;
  const sig = buf.toString('ascii', 0, 6);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }

function readColorTable(buf, off, size) {
  const table = new Array(size);
  for (let i = 0; i < size; i += 1) table[i] = [buf[off + i * 3], buf[off + i * 3 + 1], buf[off + i * 3 + 2]];
  return table;
}

function readSubBlocks(buf, off) {
  const chunks = [];
  let p = off;
  for (;;) {
    if (p >= buf.length) throw new Error('GIF 数据块截断');
    const n = buf[p];
    p += 1;
    if (n === 0) break;
    if (p + n > buf.length) throw new Error('GIF 子块越界');
    chunks.push(buf.subarray(p, p + n));
    p += n;
  }
  return { data: Buffer.concat(chunks), next: p };
}

/** 轻量扫结构：只拆块、不算像素，拿到帧数/延迟/每帧的 LZW 数据。 */
function scanGif(buf) {
  if (!isGifBuffer(buf)) return null;
  const width = u16(buf, 6);
  const height = u16(buf, 8);
  if (!width || !height) return null;
  const packed = buf[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 1 << ((packed & 0x07) + 1);
  let p = 13;
  let globalTable = null;
  if (gctFlag) {
    if (p + gctSize * 3 > buf.length) return null;
    globalTable = readColorTable(buf, p, gctSize);
    p += gctSize * 3;
  }

  const frames = [];
  let gce = { delayMs: 100, transparentIndex: -1, disposal: 0 };
  for (;;) {
    if (p >= buf.length) break;
    const marker = buf[p];
    p += 1;
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) { // extension
      if (p >= buf.length) break;
      const label = buf[p];
      p += 1;
      if (label === 0xf9) {
        if (p + 6 > buf.length) return null;
        const size = buf[p];
        if (size !== 4) {
          // 不规范的 GCE：按 size 跳过
          p += 1 + size;
          if (buf[p] === 0) p += 1;
          continue;
        }
        const flags = buf[p + 1];
        const delay = u16(buf, p + 2);
        const trans = buf[p + 4];
        gce = {
          delayMs: Math.max(10, delay * 10),
          transparentIndex: (flags & 0x01) ? trans : -1,
          disposal: (flags >> 2) & 0x07,
        };
        p += 1 + 4;
        if (buf[p] === 0) p += 1;
      } else {
        // 其它扩展（注释/应用/纯文本）：跳过子块
        const skipped = readSubBlocks(buf, p);
        p = skipped.next;
      }
      continue;
    }
    if (marker !== 0x2c) return null; // 未知块，保守失败
    if (p + 9 > buf.length) return null;
    const left = u16(buf, p);
    const top = u16(buf, p + 2);
    const w = u16(buf, p + 4);
    const h = u16(buf, p + 6);
    const fpacked = buf[p + 8];
    p += 9;
    const lctFlag = (fpacked & 0x80) !== 0;
    const interlace = (fpacked & 0x40) !== 0;
    const lctSize = 1 << ((fpacked & 0x07) + 1);
    let localTable = null;
    if (lctFlag) {
      if (p + lctSize * 3 > buf.length) return null;
      localTable = readColorTable(buf, p, lctSize);
      p += lctSize * 3;
    }
    if (!w || !h) return null;
    if (p >= buf.length) return null;
    const minCodeSize = buf[p];
    p += 1;
    const blocks = readSubBlocks(buf, p);
    p = blocks.next;
    frames.push({
      left, top, width: w, height: h, interlace,
      table: localTable || globalTable,
      data: blocks.data,
      minCodeSize,
      delayMs: gce.delayMs,
      transparentIndex: gce.transparentIndex,
      disposal: gce.disposal,
    });
    gce = { delayMs: 100, transparentIndex: -1, disposal: 0 };
    if (frames.length >= 1000) break; // 病态文件保护
  }
  if (!frames.length) return null;
  return { width, height, frames, totalDurationMs: frames.reduce((a, f) => a + f.delayMs, 0) };
}

/** GIF 的 LZW 变长码解码（LSB-first）。返回像素索引数组。 */
function lzwDecode(minCodeSize, data, expected) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Array(4096);
  for (let i = 0; i < clear; i += 1) dict[i] = [i];
  let prev = null;
  const out = [];
  let bit = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byteIndex = bit >> 3;
      if (byteIndex >= data.length) return -1;
      code |= ((data[byteIndex] >> (bit & 7)) & 1) << i;
      bit += 1;
    }
    return code;
  };
  while (out.length < expected) {
    const code = readCode();
    if (code < 0) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat(prev[0]);
    else break;
    for (let i = 0; i < entry.length && out.length < expected; i += 1) out.push(entry[i]);
    if (prev) {
      if (next < 4096) {
        dict[next] = prev.concat(entry[0]);
        next += 1;
        if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
    }
    prev = entry;
  }
  return out;
}

function rowOrder(height, interlace) {
  if (!interlace) return Array.from({ length: height }, (_, i) => i);
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

function clearRect(canvas, screenW, screenH, left, top, w, h) {
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(screenW, left + w);
  const y1 = Math.min(screenH, top + h);
  for (let y = y0; y < y1; y += 1) {
    const row = (y * screenW + x0) * 4;
    canvas.fill(0, row, row + (x1 - x0) * 4);
  }
}

function drawFrame(canvas, screenW, screenH, frame) {
  const { left, top, width, height, table, transparentIndex } = frame;
  if (!table) return;
  const indices = lzwDecode(frame.minCodeSize, frame.data, width * height);
  if (!indices.length) return;
  const rows = rowOrder(height, frame.interlace);
  for (let yy = 0; yy < rows.length; yy += 1) {
    const destY = top + rows[yy];
    if (destY < 0 || destY >= screenH) continue;
    for (let x = 0; x < width; x += 1) {
      const destX = left + x;
      if (destX < 0 || destX >= screenW) continue;
      const pixel = indices[yy * width + x];
      if (pixel === undefined || pixel === transparentIndex) continue;
      const rgb = table[pixel];
      if (!rgb) continue;
      const off = (destY * screenW + destX) * 4;
      canvas[off] = rgb[0];
      canvas[off + 1] = rgb[1];
      canvas[off + 2] = rgb[2];
      canvas[off + 3] = 255;
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA → PNG（8-bit、无隔行、不压缩元数据）。 */
export function pngFromRgba(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pickIndices(total, k) {
  if (total <= k) return Array.from({ length: total }, (_, i) => i);
  // [MAXFRAMES-1] k=1 时下面的 (k-1)=0 会除出 NaN，选择集里全是 NaN → selected.has 永远不成立
  // → snapshots 为空 → extractGifFrames 返回 null（调用方以为「抽不动」）。抽一帧取中间帧。
  if (k <= 1) return [Math.floor((total - 1) / 2)];
  const out = new Set();
  for (let i = 0; i < k; i += 1) out.add(Math.round((i * (total - 1)) / (k - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * 抽关键帧。失败/单帧/非 GIF 返回 null（调用方回退单帧）。
 * @param {Buffer} buf
 * @param {{maxFrames?:number,maxDecodeFrames?:number,maxPixels?:number}} opts
 * @returns {{width:number,height:number,frameCount:number,decodedFrames:number,animated:boolean,totalDurationMs:number,truncated:boolean,frames:{index:number,delayMs:number,png:Buffer}[]}|null}
 */
export function extractGifFrames(buf, opts = {}) {
  const maxFrames = Math.max(1, Math.min(5, Number(opts.maxFrames) || 3));
  const maxDecodeFrames = Math.max(1, Math.min(300, Number(opts.maxDecodeFrames) || 60));
  const maxPixels = Math.max(1, Number(opts.maxPixels) || MAX_PIXELS_DEFAULT);
  if (!isGifBuffer(buf)) return null;
  let scanned;
  try { scanned = scanGif(buf); } catch { return null; }
  if (!scanned) return null;
  const { width, height } = scanned;
  if (width * height > maxPixels) return null;
  const all = scanned.frames;
  const truncated = all.length > maxDecodeFrames;
  const decodeList = all.slice(0, maxDecodeFrames);
  const selected = new Set(pickIndices(decodeList.length, maxFrames));
  const canvas = Buffer.alloc(width * height * 4, 0);
  const snapshots = [];
  let previous = null;
  for (let i = 0; i < decodeList.length; i += 1) {
    const frame = decodeList[i];
    if (frame.disposal === 3) previous = Buffer.from(canvas);
    try { drawFrame(canvas, width, height, frame); } catch { return null; }
    if (selected.has(i)) {
      snapshots.push({ index: i, delayMs: frame.delayMs, png: pngFromRgba(canvas, width, height) });
    }
    if (frame.disposal === 2) {
      clearRect(canvas, width, height, frame.left, frame.top, frame.width, frame.height);
    } else if (frame.disposal === 3 && previous) {
      previous.copy(canvas);
    }
  }
  if (!snapshots.length) return null;
  return {
    width,
    height,
    frameCount: all.length,
    decodedFrames: decodeList.length,
    animated: all.length > 1,
    totalDurationMs: scanned.totalDurationMs,
    truncated,
    frames: snapshots,
  };
}
