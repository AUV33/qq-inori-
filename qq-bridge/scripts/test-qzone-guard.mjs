import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadComments, saveComments, findPriorComment, recordComment, renderReplyContent, resolveGuardFile } from '../../ai-companion-kit/packages/qzone-mcp/src/qzone-comment-guard.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

const DAY = 86400000;
const now = Date.now();

ok('30 天内评过会被找到（带去重信息）', () => {
  const c = {};
  recordComment(c, 'tid1', '可爱', now - 3 * DAY);
  const p = findPriorComment(c, 'tid1', now);
  assert.ok(p);
  assert.equal(p.content, '可爱');
  assert.equal(p.ageDays, 3);
});

ok('超过 30 天 / 没评过返回 null', () => {
  const c = {};
  recordComment(c, 'tid2', '老评论', now - 40 * DAY);
  assert.equal(findPriorComment(c, 'tid2', now), null);
  assert.equal(findPriorComment(c, 'nope', now), null);
});

ok('重复记录累加 count 并保留最新内容', () => {
  const c = {};
  recordComment(c, 'tid3', '一', now - 2 * DAY);
  recordComment(c, 'tid3', '二', now);
  assert.equal(c.tid3.count, 2);
  assert.equal(c.tid3.content, '二');
});

ok('回评前缀：@对方 + 内容；空内容返回空', () => {
  assert.equal(renderReplyContent('好耶', '小明'), '@小明 好耶');
  assert.equal(renderReplyContent('好耶'), '好耶');
  assert.equal(renderReplyContent('   ', '小明'), '');
});

ok('落盘/读回 + 上限裁剪', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzguard-'));
  const file = path.join(dir, 'qzone-comments.json');
  const c = {};
  for (let i = 0; i < 520; i += 1) recordComment(c, 't' + i, 'x', now - i * 1000);
  assert.equal(saveComments(file, c), true);
  const back = loadComments(file);
  assert.ok(Object.keys(back).length <= 500);
  assert.ok(back.t0);
});

ok('resolveGuardFile 优先显式目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzguard2-'));
  const f = resolveGuardFile({ envDir: dir });
  assert.equal(path.dirname(f), dir);
});

console.log(`🎉 空间评论守卫测试通过（${passed} 项）`);
