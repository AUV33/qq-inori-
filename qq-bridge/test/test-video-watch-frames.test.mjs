import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession, stepSession } from '../src/domain/leaves/inori-videowatch.js';

test('video_watch：look 必须返回可渲染的 30 秒窗口', () => {
  const sess = openSession(
    { bvid: 'BV1test', title: 'test', owner: 'up', duration: 90 },
    { windows: 3 },
  );
  const r = stepSession(sess, { op: 'look' });
  assert.ok(r.viewWindow, 'look 没有 viewWindow，画面层会永远空白');
  assert.equal(r.viewWindow.from, 0);
  assert.equal(r.viewWindow.to, 30);
  assert.equal(r.session.pos, 30);
});

test('ownlife 提示：明确给出 video_feed/video_watch 的入口', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'domain', 'social', 'own-life.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(here, '..', '..', 'data', 'prompts', 'ownlife-day.md'), 'utf8');
  assert.ok(src.includes('video_feed 给个关键词'), 'own-life 默认提示缺少 video_feed 关键词入口');
  assert.ok(src.includes('video_watch 一段段看'), 'own-life 默认提示缺少 video_watch');
  assert.ok(prompt.includes('video_feed 给个关键词'), 'ownlife-day.md 缺少 video_feed 关键词入口');
  assert.ok(prompt.includes('video_watch 一段段看'), 'ownlife-day.md 缺少 video_watch');
});

test('mcp-host-server：先记住 viewWindow，再写回 a.sess，旧自比较 bug 不再存在', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'mcp-host-server.js'), 'utf8');
  assert.ok(src.includes('const shouldRenderWindow = Boolean(viewWindow)'), '缺少 shouldRenderWindow 快照');
  assert.ok(!src.includes('if (viewWindow && session !== a.sess)'), '旧的恒 false 比较还在');
  assert.ok(src.includes('if (shouldRenderWindow)'), '窗口渲染分支未接回');
});
