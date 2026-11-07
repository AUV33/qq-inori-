import test from 'node:test';
import assert from 'node:assert/strict';
import { seeVideo } from '../../ai-companion-kit/packages/shared/video-understanding.js';
import { extractMediaFromSegments } from '../src/domain/shared/cq-segments.mjs';

test('A：QQ 发来的视频本体不再被丢掉', () => {
  const media = extractMediaFromSegments([{
    type: 'video',
    data: { thumbUrl: 'https://img/cover.jpg', url: 'https://cdn/qq/video.mp4', file: 'abc.mp4', duration: 42 },
  }]);
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, 'video-thumb');
  assert.equal(media[0].url, 'https://img/cover.jpg');
  assert.equal(media[0].videoUrl, 'https://cdn/qq/video.mp4');
  assert.equal(media[0].videoFile, 'abc.mp4');
  assert.equal(media[0].duration, '42');
  // 只有本体、没有封面时也必须进得来
  const noThumb = extractMediaFromSegments([{ type: 'video', data: { url: 'https://cdn/qq/v.mp4' } }]);
  assert.equal(noThumb.length, 1);
  assert.equal(noThumb[0].url, '');
  assert.equal(noThumb[0].videoUrl, 'https://cdn/qq/v.mp4');
  // 网关只给缓存文件名、没有直链时，也别把视频整个丢掉
  const fileOnly = extractMediaFromSegments([{ type: 'video', data: { file: 'cache.mp4' } }]);
  assert.equal(fileOnly.length, 1);
  assert.equal(fileOnly[0].videoFile, 'cache.mp4');
  assert.equal(fileOnly[0].videoUrl, '');
});

test('A：眼睛把视频本体变成带时刻的画面', async () => {
  const frames = await seeVideo('https://cdn/qq/video.mp4', {
    framesFromVideo: async (_src, { count }) => [
      { data: 'QQ==', mimeType: 'image/jpeg', at: 0 },
      { data: 'Qg==', mimeType: 'image/jpeg', at: 5 },
    ].slice(0, count),
    maxFrames: 4,
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].at, 0);
  assert.equal(frames[1].at, 5);
  assert.equal(frames[0].data, 'QQ==');
});

test('A：没有取帧执行器或失败时，看不见就是空数组', async () => {
  assert.deepEqual(await seeVideo('https://cdn/qq/video.mp4', {}), []);
  assert.deepEqual(await seeVideo('https://cdn/qq/video.mp4', {
    framesFromVideo: async () => { throw new Error('no ffmpeg'); },
  }), []);
  assert.deepEqual(await seeVideo(null, { framesFromVideo: async () => [{ data: 'QQ==' }] }), []);
});

test('B 开关：取帧数量由 count 决定，不写死', async () => {
  let got = 0;
  await seeVideo('https://cdn/qq/video.mp4', {
    framesFromVideo: async (_src, { count }) => { got = count; return []; },
    maxFrames: 12,
  });
  assert.equal(got, 12);
});
