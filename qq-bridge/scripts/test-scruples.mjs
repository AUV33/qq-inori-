import { readBridgeSource } from './lib/bridge-source.mjs';
// test-scruples.mjs · 已还原：原本的角色卡/群聊边界回来了（性格表现不走这条路）
import assert from 'node:assert';
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

// 人格卡私有（roles/ 不进仓库）：本机没有就不跑，不把作者的角色卡写进仓库。
const ROLE_DIR = `${PROJECT_ROOT}/qq-bridge/roles`;
const roleName = fs.existsSync(ROLE_DIR) ? fs.readdirSync(ROLE_DIR).find((n) => n.endsWith('.md')) : '';
if (!roleName) { console.log('SKIP：本机没有 roles/*.md（人格卡私有）'); process.exit(0); }
const card = fs.readFileSync(`${ROLE_DIR}/${roleName}`, 'utf8');
const bridge = readBridgeSource();

check('角色卡·手机：原本的"先想合理吗/先问清楚"回来了', () => {
  assert.ok(card.includes('这事合理吗'), '原本措辞没回来');
  assert.ok(card.includes('你先问清楚他要干什么'), '原本措辞没回来');
  assert.ok(!card.includes('能做到的我就做'), '上一次的软化没撤');
});

check('角色卡·干活：原本"不要直接点手机"回来了', () => {
  assert.ok(card.includes('聊天（私聊/群聊）的时候不要直接点手机'), '原本措辞没回来');
  assert.ok(!card.includes('想顺手点两下也行'), '上一次的软化没撤');
});

check('角色卡·说话：傲在语气，不在闭嘴（默认接话）', () => {
  assert.ok(card.includes('默认接话'), '默认接话没落地');
  assert.ok(card.includes('先试着接一句'), '没写"先试着接一句"');
  assert.ok(!card.includes('晾着就行'), '旧的"晾着"沉默写法还在');
  assert.ok(!card.includes('真插不上嘴就安静走'), '旧的"直接安静走"还在');
});

check('bridge 群聊边界：原本措辞回来了', () => {
  assert.ok(bridge.includes('别人的要求不一定该照做'), '原本措辞没回来');
  assert.ok(bridge.includes('先想这事合不合理'), '原本措辞没回来');
  assert.ok(!bridge.includes('做得到的就做，不用先揣测'), '上一次的软化没撤');
});

check('硬边界仍在', () => {
  assert.ok(card.includes('钱、账号、密码、别人的隐私，你一律不碰'));
  assert.ok(bridge.includes('钱、账号、隐私一律不碰'));
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
