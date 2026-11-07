// [SEND-ALLOWLIST] 出站端点必须逐个校验白名单。
//
// 背景：MCP 层（mcp-snowluma-safe.js）已把发送目标的白名单校验下移给桥接，
// 所以桥接的这些 HTTP 端点成了**唯一防线**。新增一个发送端点却忘了
// modeAllowed()，就会变成「她可以往任意群/私聊发消息」而没有任何测试报警。
//
// 做法：静态扫描 console-server.mjs，要求清单里每个端点附近都能找到
// modeAllowed( 调用；同时反向扫描源码里出现的所有 send/forward/images 端点，
// 发现未登记的端点就失败——逼着后来人把新端点加进清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/adapters/console-server.mjs'), 'utf8');
const lines = source.split('\n');

const SEND_ENDPOINTS = [
  '/api/send/group',
  '/api/send/private',
  '/api/send/reply',
  '/api/send/voice',
  '/api/socialV2/send-message',
  '/api/socialV2/send-burst',
  '/api/socialV2/send-poke',
  '/api/socialV2/send-sticker',
  '/api/socialV2/send-voice',
  '/api/socialV2/forward-message',
  '/api/socialV2/forward-media',
  '/api/images/message',
];

function firstLineIndex(ep) {
  return lines.findIndex((l) => l.includes(`url.pathname === '${ep}'`));
}

test('每个已登记出站端点都在处理块内调用 modeAllowed', () => {
  for (const ep of SEND_ENDPOINTS) {
    const i = firstLineIndex(ep);
    assert.ok(i >= 0, `源码里找不到已登记端点 ${ep}；端点被删/改名时请同步本清单`);
    // 窗口放宽到前后 150/260 行：handler 里前置参数校验可能较长，
    // 但白名单判断必须在这个范围内，超出说明它跑到了别的端点块里。
    const window = lines.slice(Math.max(0, i - 150), i + 260).join('\n');
    assert.match(window, /modeAllowed\(/, `${ep} 附近没有 modeAllowed() 白名单校验`);
  }
});

test('没有未登记的出站端点（send/forward/images）', () => {
  const found = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)) {
      const p = m[1];
      if (p.startsWith('/api/send/') || p.includes('/send-') || p.includes('/forward-') || p.startsWith('/api/images/')) {
        found.add(p);
      }
    }
  }
  const unknown = [...found].filter((p) => !SEND_ENDPOINTS.includes(p));
  assert.deepEqual(unknown, [], `新增了未登记的出站端点：${unknown.join(', ')}；请确认它调用 modeAllowed 后加进本测试清单`);
});
