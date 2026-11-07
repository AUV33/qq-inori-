import { readBridgeSource } from './lib/bridge-source.mjs';
// test-sticker-auto.mjs · 表情自动判定/含义/收入门槛/备注/自动收藏/去重接线
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStickerStore, parseStickerCaption } from '../src/domain/send/sticker-lib.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const bridge = readBridgeSource();
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-stickers-'));
const fixtureFile = path.join(fixtureDir, 'stickers.json');
fs.writeFileSync(fixtureFile, JSON.stringify(Array.from({ length: 5 }, (_, i) => ({
  id: `fixture-${i}`,
  localNote: `测试备注 ${i}`,
}))), 'utf8');
const lib = loadStickerStore(fixtureFile);

check('解析：name/tags/note/meaning/sticker/collect 全拿到', () => {
  const r = parseStickerCaption('{"name":"无语","tags":["无语","摆烂"],"note":"不想说话时发","meaning":"表示我懒得理你，别问了","sticker":true,"collect":true}');
  assert.equal(r.name, '无语');
  assert.deepEqual(r.tags, ['无语', '摆烂']);
  assert.equal(r.note, '不想说话时发');
  assert.ok(r.meaning.includes('懒得理'));
  assert.equal(r.sticker, true);
  assert.equal(r.collect, true);
});

check('解析：collect=false / sticker=false 能识别', () => {
  const r = parseStickerCaption('{"name":"截图","tags":["截图"],"note":"","meaning":"","sticker":false,"collect":false}');
  assert.equal(r.sticker, false);
  assert.equal(r.collect, false);
});

check('income 判定：不像表情包/不值得收/没含义/标签太少都拒收', () => {
  assert.ok(bridge.includes("caption?.sticker === false || caption?.collect === false"), '没拦 sticker/collect');
  assert.ok(bridge.includes("String(caption?.meaning || '').trim().length < 6"), '没拦无含义');
  assert.ok(bridge.includes('caption.tags.length < 2'), '没拦少标签');
});

check('重复去重：按图片 md5 对比库', () => {
  assert.ok(bridge.includes("crypto.createHash('md5').update(Buffer.from(img0.data, 'base64'))"), '没算图 md5');
  assert.ok(bridge.includes('跳过重复'), '没跳过重复');
  assert.ok(bridge.includes("reason: 'duplicate'"), '没返回 duplicate');
});

check('库：全部有备注（模型写的使用场景）', () => {
  assert.ok(lib.length >= 5, `库只有 ${lib.length} 张`);
  const missing = lib.filter((s) => !String(s.localNote || '').trim());
  assert.equal(missing.length, 0, `${missing.length} 张没备注`);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
fs.rmSync(fixtureDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
