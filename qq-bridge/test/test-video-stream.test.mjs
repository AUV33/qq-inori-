import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickNextCandidate } from '../src/domain/leaves/inori-videowatch.js';

test('pickNextCandidate：手动接下一条，跳过看过的，走到尾部返回 exhausted', () => {
  const feed = {
    nextIndex: 0,
    list: [
      { bvid: 'BVa', title: 'a' },
      { bvid: 'BVb', title: 'b' },
      { bvid: 'BVc', title: 'c' },
    ],
  };
  const first = pickNextCandidate(feed, { seen: [] });
  assert.equal(first.entry.bvid, 'BVa');
  assert.equal(first.nextIndex, 1);

  const second = pickNextCandidate({ ...feed, nextIndex: first.nextIndex }, { seen: ['BVb'] });
  assert.equal(second.entry.bvid, 'BVc');
  assert.equal(second.nextIndex, 3);

  const end = pickNextCandidate({ ...feed, nextIndex: 3 }, { seen: [] });
  assert.equal(end.entry, null);
  assert.equal(end.exhausted, true);
});

test('mcp-host-server：video_feed 存队列，video_watch 有 next 动作', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'mcp-host-server.js'), 'utf8');
  assert.ok(src.includes("op: z.enum(['open', 'look', 'skip', 'rewatch', 'exit', 'next'])"), 'next 未注册');
  assert.ok(src.includes('videoState.feed ='), 'video_feed 未保存候选队列');
  assert.ok(src.includes("if (op === 'next')"), 'next 分支未接');
  assert.ok(src.includes('pickNextCandidate(feed'), 'next 未使用候选选择器');
  assert.ok(!src.includes('biliTrending(12)'), 'video_feed 仍在拉热榜');
  assert.ok(src.includes('const list = await biliSearch(q'), 'video_feed 未按关键词搜索');
  assert.ok(src.includes('不摆热榜'), '工具描述没有说明不摆热榜');
});
