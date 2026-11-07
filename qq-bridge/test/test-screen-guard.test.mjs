// [EYE-1] 手机截屏的「眼睛保护」：熄灭的屏幕不能当画面递给她。
//
// 2026-10-29 00:21 实机：她找「开始行动」按钮，工具报「截图全黑，未见橙色按钮」，
// 她自己说「屏幕亮着但滑不动」。根因是 adb screencap 在熄屏/锁屏时返回全黑图，
// 而截图前不唤醒、截完不判黑帧。这里锁住三件事：
//   ① 屏幕状态解析（dumpsys power）② 黑帧判定（全黑才算黑，深色界面/白字不能误伤）
//   ③ pngLuma 真的能从 PNG 里读出亮度；④ 接线（两个截屏入口都走 screen-guard）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseWakefulness, isBlackFrame, blackFrameReason, ensureAwake, screenAwake,
} from '../../ai-companion-kit/packages/phone-mcp/src/screen-guard.js';
import { pngLuma } from '../../ai-companion-kit/packages/phone-mcp/src/png-scale.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// 造一张纯色/带白点的 RGBA PNG（filter=0，测 pngLuma 用）
function makePng(width, height, pixelAt) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('parseWakefulness：读得出 Awake/Asleep/Dozing，读不到返回空串', () => {
  assert.equal(parseWakefulness('mWakefulness=Awake'), 'Awake');
  assert.equal(parseWakefulness('  mWakefulness=Asleep  '), 'Asleep');
  assert.equal(parseWakefulness('mWakefulness=Dozing'), 'Dozing');
  assert.equal(parseWakefulness('随便什么输出'), '');
  assert.equal(parseWakefulness(null), '');
});

test('isBlackFrame：全黑才算黑；深色界面带白字不算（max 高）', () => {
  assert.equal(isBlackFrame({ mean: 0, max: 0 }), true, '纯黑帧');
  assert.equal(isBlackFrame({ mean: 3, max: 20 }), true, '接近全黑也算');
  assert.equal(isBlackFrame({ mean: 3, max: 200 }), false, '黑底白字不能误判');
  assert.equal(isBlackFrame({ mean: 60, max: 255 }), false, '正常画面');
  assert.equal(isBlackFrame(null), false, '拿不到统计不误伤');
  assert.equal(isBlackFrame({ mean: 'x' }), false, '坏数据不误伤');
});

test('pngLuma：纯黑 mean≈0；纯白 mean=255；黑底白点 max 高', () => {
  const black = pngLuma(makePng(8, 8, () => [0, 0, 0, 255]));
  assert.ok(black && black.mean === 0 && black.max === 0, `纯黑亮度应为 0，实际 ${JSON.stringify(black)}`);
  assert.equal(isBlackFrame(black), true);

  const white = pngLuma(makePng(8, 8, () => [255, 255, 255, 255]));
  assert.ok(white && white.mean === 255, `纯白平均应为 255，实际 ${JSON.stringify(white)}`);
  assert.equal(isBlackFrame(white), false);

  const dot = pngLuma(makePng(8, 8, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255])));
  assert.ok(dot && dot.mean < 6 && dot.max === 255, '黑底一个白点：mean 低但 max 高');
  assert.equal(isBlackFrame(dot), false, '有内容就不能当黑帧');
});

test('ensureAwake：醒着不按电源键；睡着按一次；按不醒如实返回', async () => {
  const calls = [];
  const awake = async (cmd) => { calls.push(cmd); return 'mWakefulness=Awake'; };
  assert.equal(await ensureAwake(awake, async () => {}), 'awake');
  assert.ok(!calls.some((c) => c.includes('keyevent')), '醒着不该按电源键');

  const seq = [];
  const asleepThenAwake = async (cmd) => {
    seq.push(cmd);
    if (cmd.includes('dumpsys')) return seq.filter((c) => c.includes('dumpsys')).length === 1 ? 'mWakefulness=Asleep' : 'mWakefulness=Awake';
    return '';
  };
  assert.equal(await ensureAwake(asleepThenAwake, async () => {}), 'woke');
  assert.ok(seq.some((c) => c.includes('KEYCODE_WAKEUP')), '睡着要按电源键唤醒');

  const alwaysAsleep = async (cmd) => (cmd.includes('dumpsys') ? 'mWakefulness=Asleep' : '');
  assert.equal(await ensureAwake(alwaysAsleep, async () => {}), 'wake-failed');

  const broken = async () => { throw new Error('adb 挂了'); };
  assert.equal(await screenAwake(broken), 'unknown', '读不到状态当 unknown，不挡截图');
  assert.equal(blackFrameReason().includes('屏幕是黑的'), true);
});

test('接线：phone_look 与本地视觉的截图入口都走 screen-guard', () => {
  const vision = read('../../ai-companion-kit/packages/phone-mcp/src/vision-tool.js');
  assert.ok(vision.includes("from './screen-guard.js'"), 'vision-tool 必须引入 screen-guard');
  assert.ok(vision.includes('ensureAwake(shellCmd'), 'phone_look 截屏前要先唤醒');
  assert.ok(vision.includes('isBlackFrame('), 'phone_look 要判黑帧');
  assert.ok(vision.includes('blackFrameReason()'), '黑帧要给明确原因');

  const local = read('../../ai-companion-kit/packages/phone-mcp/src/local-vision.js');
  assert.ok(local.includes("from './screen-guard.js'"), 'local-vision 必须引入 screen-guard');
  assert.ok(local.includes('blackFrameReason()'), 'OCR/模板/按描述点也要在黑帧时明说');
});
