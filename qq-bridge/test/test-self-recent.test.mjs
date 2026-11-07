// [SELF-RECENT] 跨会话自我连续性：只递她自己在别处说过的话，过期/本会话的不递。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSelfRecent } from '../src/domain/leaves/inori-self-recent.mjs';

const now = Date.parse('2026-10-30T21:10:00+08:00');
const utt = (minAgo, text, key, kind = 'utterance') => ({ kind, key, text, time: now - minAgo * 60000, at: new Date(now - minAgo * 60000).toISOString() });

test('群会话默认不递私聊的话；显式 allowPrivate 才递', () => {
  const entries = [
    utt(30, '电脑上起一张白图，拿四条曲线围出翅膀', 'private:10001'),
    utt(20, '这张还是在电脑上画的', 'private:10001'),
    utt(10, '本群的话', 'group:123456789'),
  ];
  const block = renderSelfRecent(entries, { key: 'group:123456789', now });
  assert.ok(!block.includes('电脑上起一张白图'), '默认不能把私聊内容递进群');
  assert.ok(!block.includes('本群的话'), '本会话的不递');
  const opened = renderSelfRecent(entries, { key: 'group:123456789', now, allowPrivate: true });
  assert.ok(opened.includes('电脑上起一张白图'), opened);
  assert.ok(opened.includes('【你最近在别处说过的事'), opened);
  assert.ok(opened.includes('别认'), '要带「上面没有的别认」的边界');
});

test('私聊默认可以想起群里的自己；allowGroup=false 时关闭', () => {
  const entries = [utt(10, '群里发生的事', 'group:123456789')];
  const block = renderSelfRecent(entries, { key: 'private:10001', now });
  assert.ok(block.includes('群里发生的事'), block);
  assert.equal(renderSelfRecent(entries, { key: 'private:10001', now, allowGroup: false }), '');
});

test('超过 3 小时的不算「最近」，非 utterance 不收', () => {
  const entries = [
    utt(4 * 60, '四个小时前的事', 'private:1'),
    utt(30, '事实条目', 'private:1', 'fact'),
    utt(5, '刚才说的事', 'private:1'),
  ];
  const block = renderSelfRecent(entries, { key: 'group:9', now, allowPrivate: true });
  assert.ok(block.includes('刚才说的事'));
  assert.ok(!block.includes('四个小时前的事'));
  assert.ok(!block.includes('事实条目'));
});

test('没有可递的就返回空串（不造暗示）', () => {
  assert.equal(renderSelfRecent([], { key: 'group:9', now }), '');
  assert.equal(renderSelfRecent([utt(1, '本会话', 'group:9')], { key: 'group:9', now }), '');
});

test('最多 maxLines 条、按时间正序、同文去重', () => {
  const entries = [
    utt(60, '一', 'private:1'),
    utt(50, '二', 'private:1'),
    utt(40, '三', 'private:1'),
    utt(30, '四', 'private:1'),
    utt(20, '四', 'private:1'),
  ];
  const block = renderSelfRecent(entries, { key: 'group:9', now, maxLines: 3, allowPrivate: true });
  const lines = block.split('\n').filter((l) => /^\d{2}:\d{2}/.test(l));
  assert.equal(lines.length, 3);
  // 从最近往前取 3 条（四/三/二），再按时间正序展示
  assert.ok(lines[0].includes('二') && lines[2].includes('四'), lines.join('|'));
});
