import test from 'node:test';
import assert from 'node:assert/strict';
import { toEyes, lookAt, see } from '../../ai-companion-kit/packages/shared/video-understanding.js';

test('眼睛：任意形态的帧都归一成画面', () => {
  const eyes = toEyes(['https://img/1.jpg', { path: '/tmp/2.jpg', at: 30 }, { data: 'AA==', mimeType: 'image/png' }]);
  assert.equal(eyes.length, 3);
  assert.equal(eyes[0].url, 'https://img/1.jpg');
  assert.equal(eyes[0].at, null);
  assert.equal(eyes[1].at, 30);
  assert.equal(eyes[2].data, 'AA==');
  assert.deepEqual(toEyes(null), []);
});

test('眼睛：多张拼图时按时刻挑对应那张，不再永远给第一张', () => {
  const sheets = ['s0.jpg', 's1.jpg', 's2.jpg'];
  assert.deepEqual(lookAt(sheets, 0, { coverage: 900 }).map((e) => e.url), ['s0.jpg']);
  assert.deepEqual(lookAt(sheets, 640, { coverage: 900 }).map((e) => e.url), ['s2.jpg']);
  assert.equal(lookAt(['only.jpg'], 640, { coverage: 900 }).length, 1);
  assert.equal(lookAt(sheets, null, { coverage: 900 }).length, 3);
});

test('眼睛：把 URL 变成能看的图片字节', async () => {
  const eyes = await see(['https://img/1.jpg'], {
    fetchImage: async () => ({ buffer: Buffer.from('ffd8ff', 'hex') }),
    imageMime: () => 'image/jpeg',
  });
  assert.equal(eyes.length, 1);
  assert.equal(eyes[0].data, Buffer.from('ffd8ff', 'hex').toString('base64'));
  assert.equal(eyes[0].mimeType, 'image/jpeg');
});

test('眼睛：已经有字节的帧直接用，不再下载', async () => {
  const eyes = await see([{ data: 'AA==', mimeType: 'image/png', at: 5 }], { fetchImage: async () => { throw new Error('不该下载'); } });
  assert.equal(eyes.length, 1);
  assert.equal(eyes[0].at, 5);
  assert.equal(eyes[0].mimeType, 'image/png');
});

test('眼睛：看不见就是空数组，没有别的状态', async () => {
  const eyes = await see(['https://img/1.jpg'], {
    fetchImage: async () => { throw new Error('HTTP 413'); },
  });
  assert.deepEqual(eyes, []);
});
