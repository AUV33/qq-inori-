import { readBridgeSource } from './lib/bridge-source.mjs';
// test-agency.mjs · 12：只读群窗 + self-wake 指定群
import assert from 'node:assert';
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const bridge = readBridgeSource();
const mcp = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/src/mcp-snowluma-safe.js`, 'utf8');

check('只读群窗：readTokenFor / readTokenOkMain / 群窗文本都在', () => {
  assert.ok(bridge.includes('function readTokenFor('), '没有只读 token 生成');
  assert.ok(bridge.includes('function readTokenOkMain('), '没有只读 token 校验');
  assert.ok(bridge.includes('function groupReadWindowText('), '没有群窗文本');
  assert.ok(bridge.includes('【你自己的群窗（只读）】'), '群窗提示没写');
});

check('只读只放开 unread/recent，不放开发送', () => {
  // 计数只算**调用点**：`function readTokenOkMain(` 是定义、`get readTokenOkMain()` 是 DI 接线，
  // 两者都不算"用在哪个端点"。重构把 HTTP 路由搬到 console-server.mjs 后，调用点仍是 unread/recent 两处。
  const all = (bridge.match(/readTokenOkMain\(/g) || []).length;
  const defs = (bridge.match(/function readTokenOkMain\(|get readTokenOkMain\(\)/g) || []).length;
  const n = all - defs;
  assert.equal(n, 2, `readTokenOkMain 应只在 unread+recent 两处调用（实际 ${n}）`);
  // 发送类端点的鉴权块里不能出现只读 token
  for (const path of ["'/api/socialV2/send'", "'/api/socialV2/send-many'", "'/api/socialV2/mark-read'"]) {
    const i = bridge.indexOf(path);
    if (i < 0) continue;
    const seg = bridge.slice(i, i + 900);
    assert.ok(!seg.includes('readTokenOkMain'), `${path} 的鉴权里出现了只读 token`);
  }
});

check('ownlife/free-tick 投递会附只读群窗', () => {
  assert.ok(bridge.includes("kind === 'ownlife'"), '没挂在 ownlife 上');
  assert.ok(bridge.includes('groupReadWindowText()'), '没调用群窗');
});

check('self-wake 允许私聊 token 约群', () => {
  assert.ok(bridge.includes('selfWakeOwnerKey'), '没放开私聊约群');
  assert.ok(bridge.includes("String(key).startsWith('group:')"), '没校验群 key');
  assert.ok(!bridge.includes('agentTokenOk(ownerKey, swTok)'), '又用了作用域外的 ownerKey（会 500）');
});

check('只读校验不依赖控制台闭包里的 tokenEq', () => {
  const i = bridge.indexOf('function readTokenOkMain(');
  const seg = bridge.slice(i, i + 400);
  assert.ok(!seg.includes('tokenEq('), 'readTokenOkMain 又引用了跨作用域的 tokenEq');
  assert.ok(seg.includes('timingSafeEqual'), '没有定长比较');
});

check('工具描述更新：群窗只读 / self-wake 可约群', () => {
  assert.ok(mcp.includes('只读 token'), '未读工具描述没写只读');
  assert.ok(mcp.includes('可以在私聊里约自己去某个群'), 'self-wake 描述没写约群');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
