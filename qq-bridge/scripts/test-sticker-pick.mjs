import { readBridgeSource } from './lib/bridge-source.mjs';
// test-sticker-pick.mjs · 表情按话题预选 + 唤醒接线
import assert from 'node:assert';
import fs from 'node:fs';
import { pickStickerByQuery } from '../src/domain/send/sticker-lib.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const entries = [
  { id: 'a', md5: 'AAAA1111', desc: '缩成一团', tags: ['躲起来', '自闭', '无语', '认怂'] },
  { id: 'b', md5: 'BBBB2222', desc: '震惊到张大嘴', tags: ['震惊', '吃惊', '懵了'] },
  { id: 'c', md5: 'CCCC3333', desc: '嚎啕大哭', tags: ['大哭', '崩溃', '伤心'] },
];
const bridge = readBridgeSource();

check('pickStickerByQuery：无语/认怂 → 缩成一团', () => {
  const r = pickStickerByQuery(entries, '今天真的无语了 想缩起来', {});
  assert.ok(r.matches.length > 0, '没有命中');
  assert.ok(String(r.matches[0].desc).includes('缩成一团'), JSON.stringify(r.matches.map((x) => x.desc)));
});

check('pickStickerByQuery：震惊 → 张大嘴', () => {
  const r = pickStickerByQuery(entries, '我震惊了 怎么会这样', {});
  assert.ok(r.matches.length > 0);
  assert.ok(String(r.matches[0].desc).includes('震惊'), JSON.stringify(r.matches.map((x) => x.desc)));
});

check('bridge 接线：唤醒里预挑 1~2 张并记日志', () => {
  assert.ok(bridge.includes('[STICKER-PICK]'), '缺标记');
  assert.ok(bridge.includes('stickerPickLine'), '没接进 base');
  assert.ok(bridge.includes('【这轮对得上的表情】'), '提示文案缺');
  assert.ok(bridge.includes('[sticker-pick]'), '缺日志');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
