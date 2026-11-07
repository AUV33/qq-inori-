// feed-tool SSRF / 解析回归测试（不依赖真网、不依赖 zod）
//
// 重点：feed_posts 接受用户给的 RSS 地址，修复前用原生 fetch(url) 重新解析 DNS（TOCTOU/SSRF 缺口）。
// 修复后走 ssrf-safe.safeFetch（连已校验 IP、解析结果全判私网）。本测试验证私网地址被端到端拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFeedTool, parseFeed } from '../src/feed-tool.js';

// 递归桩：满足 z.string().optional().describe(...) 链式调用，免去对 zod 的依赖。
const zStub = new Proxy(function () {}, { get: () => zStub, apply: () => zStub });
const z = zStub;

test('parseFeed 解析 RSS 2.0 条目', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>测试源</title>
    <item><title>第一条</title><link>https://e.x/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>摘要内容</description></item>
    <item><title>第二条</title><link>https://e.x/2</link></item>
  </channel></rss>`;
  const f = parseFeed(rss);
  assert.equal(f.title, '测试源');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, '第一条');
  assert.equal(f.items[0].link, 'https://e.x/1');
  assert.equal(f.items[0].desc, '摘要内容');
});

test('feed_posts 拒绝私网 RSS 地址（SSRF 防护端到端）', async () => {
  let handler = null;
  const calls = { tool: (_n, _d, _s, h) => { handler = h; } };
  let failed = null, replied = null;
  const reply = (s) => { replied = s; return {}; };
  const fail = (s) => { failed = s; return { isError: true }; };
  registerFeedTool(calls, { z, reply, fail });
  assert.ok(handler, 'handler 应已注册');

  await handler({ url: 'http://127.0.0.1:9/feed.xml' });
  assert.ok(failed, `私网 RSS 应被拒绝，实际 reply=${replied}`);
  assert.match(failed, /没看上|SSRF|内网|禁止|私有/);
  assert.equal(replied, null);

  failed = null; replied = null;
  await handler({ url: 'http://169.254.169.254/latest/meta-data/' });
  assert.ok(failed, `云元数据 RSS 应被拒绝，实际 reply=${replied}`);
});
