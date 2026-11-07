import { readBridgeSource } from './lib/bridge-source.mjs';
// test-bili-tools.mjs · B站搜索/热评工具：签名确定性 + 接线锁
import assert from 'node:assert';
import fs from 'node:fs';
import { wbiSign } from '../src/domain/memory/watch-video.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('WBI 签名确定性：同参数同时间 → 同结果', () => {
  const a = wbiSign({ keyword: '猫咪', page: 1 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1760000000000);
  const b = wbiSign({ keyword: '猫咪', page: 1 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1760000000000);
  assert.equal(a, b);
  assert.match(a, /w_rid=[0-9a-f]{32}$/, '要有 32 位 md5 w_rid');
  assert.ok(a.indexOf('keyword=') < a.indexOf('page='), '参数要按 key 排序');
  assert.ok(a.includes('wts=1760000000'), '要带 wts 秒');
});

check('WBI 签名：参数变 → 签名变', () => {
  const a = wbiSign({ keyword: '猫咪' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1760000000000);
  const b = wbiSign({ keyword: '狗子' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1760000000000);
  assert.notEqual(a, b);
});

const host = fs.readFileSync(new URL('../src/mcp-host-server.js', import.meta.url), 'utf8');
const wv = fs.readFileSync(new URL('../src/watch-video.js', import.meta.url), 'utf8');

check('host 注册了 bili_search / bili_comments', () => {
  assert.ok(host.includes("'bili_search'"), '没有 bili_search');
  assert.ok(host.includes("'bili_comments'"), '没有 bili_comments');
  assert.ok(host.includes('biliBudget'), '没有限速');
});

check('watch-video 暴露搜索/热评实现', () => {
  assert.ok(wv.includes('export async function biliSearch'), '没有 biliSearch');
  assert.ok(wv.includes('export async function biliComments'), '没有 biliComments');
  assert.ok(wv.includes('x/v2/reply/wbi/main'), '热评接口不对');
  assert.ok(wv.includes('x/web-interface/wbi/search/type'), '搜索接口不对');
});

check('watch_video 把热评一起读', () => {
  assert.ok(wv.includes('biliComments(info, { limit: 6 })'), 'watchVideo 没读热评');
  assert.ok(wv.includes('【热评'), '输出里没有热评段');
});

check('bridge 的浏览/学习钩子包含 B站工具', () => {
  const bridge = readBridgeSource();
  assert.ok(bridge.includes('bili_search'), 'bridge 没接 bili_search');
  assert.ok(bridge.includes('bili_comments'), 'bridge 没接 bili_comments');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
