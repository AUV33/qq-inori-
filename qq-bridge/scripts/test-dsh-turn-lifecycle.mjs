#!/usr/bin/env node
// test-dsh-turn-lifecycle.mjs · 真·DSH 集成测试（默认跳过，显式开启才跑）
//
// 为什么单独存在：审计套件要求纯 fixture、不碰真实 DSH；但「排队—开始—结束—释放」这条路
// 只有真的跑一个 DSH 回合才证明得出来。这里走桥接自己的看图入口（真实隔离会话 + 真实槽位），
// 连续两次请求：第二次能成功 = 第一次的槽位确实释放了，没有泄漏。
//
// 用法：QQ_INORI_LIVE_DSH=1 node scripts/test-dsh-turn-lifecycle.mjs
// 成本：两次很小的视觉回合（可以忽略），不发送任何 QQ 消息。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(HERE, '..');
const BASE = 'http://127.0.0.1:3100';

// 生成一张 64×64 的合法 PNG（DSH 会校验附件；1×1 的占位图会被判 malformed）
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size = 64, rgb = [220, 80, 60]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const PNG = makePng();

function token() {
  try { return fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'utf8').replace(/^\uFEFF/, '').trim(); }
  catch { return ''; }
}

async function askOnce(tok) {
  const res = await fetch(`${BASE}/api/console/vision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': tok },
    body: JSON.stringify({ images: [PNG], mimeType: 'image/png', question: '这张图是什么颜色？只回一个词。' }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

if (process.env.QQ_INORI_LIVE_DSH !== '1') {
  console.log('SKIP：未设置 QQ_INORI_LIVE_DSH=1（审计套件不跑真实 DSH）');
  process.exit(0);
}

const tok = token();
if (!tok) { console.error('FAIL：读不到 state/console-token'); process.exit(1); }

const results = [];
for (const round of [1, 2]) {
  const { status, body } = await askOnce(tok);
  const ok = status === 200 && body?.ok === true && typeof body.text === 'string' && body.text.trim().length > 0;
  results.push({ round, status, ok, text: String(body?.text ?? '').slice(0, 40), ms: body?.ms ?? null, error: body?.error ?? null });
  if (!ok) break;
}

console.log(JSON.stringify(results, null, 2));
const passed = results.length === 2 && results.every((r) => r.ok);
console.log(passed ? 'DSH_TURN_LIFECYCLE_OK：两轮真实回合完成，槽位可复用' : 'DSH_TURN_LIFECYCLE_FAIL');
process.exit(passed ? 0 : 1);
