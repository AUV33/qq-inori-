// [SSRF-SYNC] ai-companion-kit 的 ssrf-safe.js 必须与 bridge 的 safe-fetch.js 逻辑一致。
//
// 这两份实现是有意的同步副本（kit 要能独立部署，不能反向依赖 bridge 内部文件）。
// 代价是：任何一方单独修 SSRF 漏洞，另一方就带着旧洞继续跑——历史上正是这种
// 多份 isPrivateIp/resolveSafeHost 的分叉造成过 SSRF 缺口。
//
// 本测试把「漂移」变成红灯：按函数名抽取两份文件的核心函数体，去掉注释、
// 统一 dnsLookup 命名与 Error 文案后逐字比对。只比逻辑，不要求注释相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = path.join(root, 'qq-bridge/src/domain/shared/safe-fetch.js');
const KIT = path.join(root, 'ai-companion-kit/packages/memory-mcp/src/ssrf-safe.js');

const FUNCS = [
  'withTimeout',
  'ipv4FromLast32',
  'parseEmbeddedIpv4',
  'isPrivateIp',
  'resolveSafeHost',
  'validateFetchUrl',
  'validateLimit',
  'requestOnce',
  'safeFetch',
  'looksLikeImageBuffer',
  'safeFetchBuffer',
];

/** 去掉块注释；丢掉整行注释（行首 // 或 JSDoc 的 *）。 */
function stripComments(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t === '');
    })
    .join('\n');
}

/** 归一化：忽略 Error 文案与 dnsLookup 变量名差异，折叠空白。 */
function normalize(text) {
  return stripComments(text)
    .replace(/\bnew Error\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*\1\s*\)/g, 'new Error(<msg>)')
    .replace(/\bdnsDefaultLookup\b/g, 'dnsLookup')
    .replace(/\s+/g, '')
    .trim();
}

/** 按函数名抽取函数体（靠花括号计数，够用于这两个无花括号字符串陷阱的文件）。 */
function extractFunction(text, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) return '';
  const start = m.index;
  const brace = text.indexOf('{', start);
  if (brace < 0) return '';
  let depth = 0;
  for (let i = brace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

test('ssrf-safe.js 与 safe-fetch.js 的核心函数逻辑逐字一致', () => {
  const bridge = fs.readFileSync(BRIDGE, 'utf8');
  const kit = fs.readFileSync(KIT, 'utf8');
  for (const fn of FUNCS) {
    const a = extractFunction(bridge, fn);
    const b = extractFunction(kit, fn);
    assert.ok(a, `bridge 的 safe-fetch.js 缺函数 ${fn}`);
    assert.ok(b, `kit 的 ssrf-safe.js 缺函数 ${fn}`);
    assert.equal(
      normalize(b),
      normalize(a),
      `${fn} 已漂移：kit 副本与 bridge 实现不一致。先在 bridge 修逻辑，再把同一处改动同步到 kit（本测试就是为了逼出这一步）。`,
    );
  }
});

test('两份文件都声明了同步义务（防止有人再写第三份）', () => {
  const kit = fs.readFileSync(KIT, 'utf8');
  assert.match(kit, /同步来源|同步副本|sync/i, 'ssrf-safe.js 头部应写明它是 safe-fetch.js 的同步副本');
});
