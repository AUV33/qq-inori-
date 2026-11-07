// 冲浪记录：浏览记录/去重/沉淀/摘要 纯函数自检（2026-10-26）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  newBrowseEntry, noteBrowse, pendingBrowse, renderBrowseDigest, markSedimented,
  loadBrowse, saveBrowse,
} from '../src/domain/leaves/inori-browse.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('新记录会截断过长参数', () => {
  const e = newBrowseEntry({ tool: 'web_search', arg: 'x'.repeat(200) });
  assert.equal(e.arg.length, 80); // [BROWSE-HUMAN] 归一后人话上限 80
  assert.equal(e.ok, true);
});

ok('同工具同查询 30 分钟内去重', () => {
  const t0 = 1000000;
  let store = { entries: [] };
  store = noteBrowse(store, newBrowseEntry({ at: t0, tool: 'web_search', arg: '三角洲' }));
  store = noteBrowse(store, newBrowseEntry({ at: t0 + 5 * 60 * 1000, tool: 'web_search', arg: '三角洲' }));
  assert.equal(store.entries.length, 1);
  store = noteBrowse(store, newBrowseEntry({ at: t0 + 40 * 60 * 1000, tool: 'web_search', arg: '三角洲' }));
  assert.equal(store.entries.length, 2);
});

ok('pending 只返回未沉淀的', () => {
  const store = { entries: [newBrowseEntry({ tool: 'web_search', arg: 'a' }), { ...newBrowseEntry({ tool: 'web_fetch', arg: 'b' }), sedimentedAt: 1 }] };
  assert.equal(pendingBrowse(store).length, 1);
});

ok('摘要：热搜/读标签 + 空数组返回空串', () => {
  assert.equal(renderBrowseDigest([]), '');
  const s = renderBrowseDigest([newBrowseEntry({ tool: 'web_search', arg: '方舟' }), newBrowseEntry({ tool: 'web_fetch', arg: 'https://x' })]);
  assert.ok(s.includes('搜「方舟」'));
  assert.ok(s.includes('读「https://x」'));
});

ok('markSedimented 只标记匹配项', () => {
  const a = newBrowseEntry({ at: 1, tool: 'web_search', arg: 'a' });
  const b = newBrowseEntry({ at: 2, tool: 'web_fetch', arg: 'b' });
  const store = { entries: [a, b] };
  const next = markSedimented(store, [a]);
  assert.ok(next.entries[0].sedimentedAt);
  assert.equal(next.entries[1].sedimentedAt, undefined);
});

ok('load/save 往返（临时文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-'));
  const file = path.join(dir, 'browse-log.json');
  const store = noteBrowse({ entries: [] }, newBrowseEntry({ tool: 'web_search', arg: '往返' }));
  assert.equal(saveBrowse(file, store), true);
  const back = loadBrowse(file);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].arg, '往返');
});

ok('看到的内容头会截断并进摘要（逛帖子/帖子流）', () => {
  const e = newBrowseEntry({ tool: 'browse_posts', arg: '/hupu/bbs', head: '长'.repeat(100) });
  assert.equal(e.head.length, 50); // [BROWSE-HUMAN] 归一后 head 上限 50
  const s = renderBrowseDigest([
    newBrowseEntry({ tool: 'browse_posts', arg: '/hupu/bbs', head: '狗子长大了' }),
    newBrowseEntry({ tool: 'feed_posts', arg: '/zhihu/daily', head: '蟑螂粉' }),
  ]);
  assert.ok(s.includes('看「/hupu/bbs」：狗子长大了'), s);
  assert.ok(s.includes('看「/zhihu/daily」：蟑螂粉'), s);
});

import { isLookupEntry, lastWanderAt, renderWanderNudge } from '../src/domain/leaves/inori-browse.js';

ok('查词不算闲逛、浏览站算闲逛', () => {
  assert.equal(isLookupEntry({ tool: 'mcp__web-search-safe__web_search', arg: '三角洲' }), true);
  assert.equal(isLookupEntry({ tool: 'mcp__web-search-safe__web_fetch', arg: 'https://cn.bing.com/search?q=x' }), true);
  assert.equal(isLookupEntry({ tool: 'mcp__web-search-safe__web_fetch', arg: 'https://www.bilibili.com/video/BV1' }), false);
  assert.equal(isLookupEntry({ tool: 'mcp__snowluma__browse_posts', arg: '贴吧' }), false);
});

ok('闲逛 nudge：从没逛过 / 超过 2 天 / 最近逛过返回 null', () => {
  const DAY = 86400000;
  assert.ok(renderWanderNudge([], Date.now()).includes('还没自己上网逛过'));
  const old = [{ tool: 'mcp__snowluma__browse_posts', arg: 'x', at: Date.now() - 3 * DAY }];
  assert.ok(renderWanderNudge(old, Date.now()).includes('3 天前'));
  const today = [{ tool: 'mcp__snowluma__browse_posts', arg: 'x', at: Date.now() - 3600000 }];
  assert.equal(renderWanderNudge(today, Date.now()), null);
});

ok('lastWanderAt 只看闲逛', () => {
  const DAY = 86400000;
  const es = [
    { tool: 'mcp__web-search-safe__web_search', arg: 'x', at: Date.now() - 1 * DAY },
    { tool: 'mcp__snowluma__browse_posts', arg: 'y', at: Date.now() - 5 * DAY },
  ];
  assert.equal(lastWanderAt(es), Date.now() - 5 * DAY);
});
console.log(`🎉 冲浪记录测试通过（${passed} 项）`);
