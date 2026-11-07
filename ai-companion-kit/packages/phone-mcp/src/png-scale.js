// png-scale.js · 零依赖 PNG 降采样（只处理 8bit RGB/RGBA 非交错 PNG）
// 用途：phone_look 截图前先缩小，减少 base64 体积和视觉模型耗时。
// 处理不了的情况一律返回原 Buffer（安全回退，绝不报错阻断截图）。
//
// 原理：PNG → zlib inflate → 逐行解 filter → 2x2 块平均降采样 → 重新 deflate 编码 PNG。

import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  const chunks = [];
  let off = 8; // 跳过签名
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    chunks.push({ type, data });
    off = dataStart + len + 4; // + CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) return null;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || interlace !== 0) return null; // 只支持 8bit 非交错
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) return null; // 调色板(3)不支持

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  let raw;
  try { raw = zlib.inflateSync(idat); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // 解 filter（每行开头 1 字节 filter 类型）
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          v = (v + pred) & 0xff;
          break;
        }
        default: return null;
      }
      cur[x] = v;
    }
    prev = cur;
  }
  return { width, height, channels, colorType, pixels: out };
}

function encodePng(img) {
  const { width, height, channels, colorType, pixels } = img;
  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: None
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(filtered, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;           // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Node 无 zlib.crc32 时的手写 CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 统计一张 PNG 的亮度：平均亮度（0–255）与最亮像素。
 * 用途：截图后判黑帧——手机熄屏/锁屏时 screencap 返回全黑图，不能当画面递给她。
 * 采样上限约 2 万个点（按 sqrt 步进），大图也很快；处理不了的格式返回 null（调用方按「不是黑帧」处理）。
 * @param {Buffer} buf PNG 字节
 * @returns {{mean:number, max:number, sampled:number}|null}
 */
export function pngLuma(buf) {
  try {
    const img = decodePng(buf);
    if (!img) return null;
    const { width, height, channels, pixels } = img;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * channels;
        const r = pixels[i];
        const g = channels >= 3 ? pixels[i + 1] : r;
        const b = channels >= 3 ? pixels[i + 2] : r;
        const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        sum += v;
        if (v > max) max = v;
        n += 1;
      }
    }
    return n ? { mean: Math.round(sum / n), max, sampled: n } : null;
  } catch {
    return null;
  }
}

/**
 * 把 PNG 按 factor 倍降采样（factor=2 → 宽高各减半）。
 * 任何不支持的情况返回原 Buffer。
 */
export function scalePng(buf, factor = 2) {
  try {
    const img = decodePng(buf);
    if (!img) return buf;
    if (factor < 2) return buf;
    const { width, height, channels, colorType, pixels } = img;
    const ow = Math.floor(width / factor);
    const oh = Math.floor(height / factor);
    if (ow < 64 || oh < 64) return buf; // 太小就不缩
    const stride = width * channels;
    const ostride = ow * channels;
    const out = Buffer.alloc(ostride * oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        for (let c = 0; c < channels; c++) {
          let sum = 0, n = 0;
          for (let dy = 0; dy < factor; dy++) {
            const ry = y * factor + dy;
            if (ry >= height) break;
            for (let dx = 0; dx < factor; dx++) {
              const rx = x * factor + dx;
              if (rx >= width) break;
              sum += pixels[ry * stride + rx * channels + c];
              n++;
            }
          }
          out[y * ostride + x * channels + c] = n ? Math.round(sum / n) : 0;
        }
      }
    }
    const encoded = encodePng({ width: ow, height: oh, channels, colorType, pixels: out });
    // 缩小后反而更大就不用
    return encoded.length < buf.length ? encoded : buf;
  } catch {
    return buf;
  }
}

export default scalePng;
