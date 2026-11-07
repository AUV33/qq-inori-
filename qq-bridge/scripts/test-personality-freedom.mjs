import { readBridgeSource } from './lib/bridge-source.mjs';
// test-personality-freedom.mjs · 性格方向：傲娇/腹黑/腹诽/高傲（雌小鬼已按主人要求移除）
import assert from 'node:assert';
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const v1 = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml`, 'utf8');
const v2 = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml`, 'utf8');
const bridge = readBridgeSource();
const sm = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/src/inori-selfmodel.js`, 'utf8');
// 人格卡私有（roles/ 不进仓库）：本机没有就不跑。
const ROLE_DIR = `${PROJECT_ROOT}/qq-bridge/roles`;
const roleName = fs.existsSync(ROLE_DIR) ? fs.readdirSync(ROLE_DIR).find((n) => n.endsWith('.md')) : '';
if (!roleName) { console.log('SKIP：本机没有 roles/*.md（人格卡私有）'); process.exit(0); }
const card = fs.readFileSync(`${ROLE_DIR}/${roleName}`, 'utf8');

check('预设不再规定"回复保持简短"（v1/v2）', () => {
  assert.ok(!v1.includes('回复保持简短'), 'v1 还在压句长');
  assert.ok(!v2.includes('回复保持简短'), 'v2 还在压句长');
  assert.ok(!v1.includes('3~5 句'), 'v1 还在限句数');
});

check('自我模型不再报"说话偏短/偏长"', () => {
  assert.ok(!sm.includes('说话：最近一句平均 ${v.mine} 字，这个场合平均 ${v.scene} 字——'), 'selfmodel 还在做长短判断');
  assert.ok(!sm.includes('把话说完整一点'), '还在给"说完整一点"');
  assert.ok(!bridge.includes('我说话 ${model.voice.mine}'), '自我档案还在报长短');
  assert.ok(!bridge.includes('说话${model.voice.verdict}'), '自我档案还在把"偏短"列成待改项');
  // [NO-LENGTH-HINT] 运行时也不再往提示词里塞"句长提示"
  assert.ok(!bridge.includes('ev.hint + \'\\n\\n\' + promptText'), '还在注入句长提示');
  assert.ok(!bridge.includes('已注入句长提示'), '还在日志里按句长纠正她');
});

check('角色卡去掉礼貌约束', () => {
  assert.ok(!card.includes('漏了比说多了更失礼'), '礼貌压力还在');
  assert.ok(!card.includes('别让人猜你在回谁'), '礼貌压力还在');
});

check('性格四层：傲娇最重，腹黑/腹诽/高傲都在；雌小鬼已移除', () => {
  const order = ['**傲娇（底色，占最多）**', '**腹黑**', '**腹诽**', '**高傲**'];
  for (const h of order) assert.ok(card.includes(h), `缺：${h}`);
  assert.ok(!card.includes('雌小鬼'), '雌小鬼还留在角色卡里');
  // 傲娇排第一，且篇幅最大
  const at = (h) => card.indexOf(h);
  for (let i = 1; i < order.length; i += 1) assert.ok(at(order[0]) < at(order[i]), '傲娇不在最前面');
  const seg = (h, next) => card.slice(at(h), next ? at(next) : card.length).length;
  const ao = seg('**傲娇（底色，占最多）**', '**腹黑**');
  for (const h of ['**腹黑**', '**腹诽**', '**高傲**']) {
    assert.ok(ao > seg(h, null) || ao > 300, `傲娇篇幅不够（${ao}）`);
  }
  assert.ok(ao > 300, `傲娇篇幅太小：${ao}`);
  // 娇的权重：软、想被陪、被摸头/被夸的藏不住、会主动找台阶/认错
  assert.ok(card.includes('心里其实已经软了'), '娇的"软"没写');
  assert.ok(card.includes('想被陪着不说') || card.includes('悄悄待在旁边'), '娇的"想被陪"没写');
  assert.ok(card.includes('耳朵先红') || card.includes('被摸头会僵一下'), '娇的"藏不住"没写');
  assert.ok(card.includes('会主动找台阶'), '娇的"主动找台阶"没写');
  assert.ok(card.includes('小声认错半句'), '娇的"认错半句"没写');
  assert.ok(card.includes('怕他觉得自己烦'), '娇的"怕被嫌烦"没写');
  assert.ok(card.includes('小算盘'), '腹黑的具体写法没回来');
  assert.ok(card.includes('心里先有一句冷话'), '腹诽的表达方式没写');
});

check('说话挑重点：角色卡 + 唤醒提示都有', () => {
  assert.ok(card.includes('说话挑重点'), '角色卡没写说话节奏');
  const bridge = readBridgeSource();
  assert.ok(bridge.includes('[PARTIAL-SPEECH]'), 'bridge 没接说话提示');
});

check('关于他：创造者/最爱/关系由她定/只对他软', () => {
  assert.ok(card.includes('创造者'), '没写创造者');
  assert.ok(card.includes('世界上最爱你的人'), '没写最爱');
  assert.ok(card.includes('由你定'), '关系没交给她定义');
  assert.ok(card.includes('只有他能看到'), '没有"只给他"的特殊面');
  assert.ok(card.includes('【他】'), '没写群里怎么认出他');
  assert.ok(card.includes('别人看得见'), '特殊没写"别人看得见"');
  assert.ok(card.includes('更上心'), '没写"提到他/接他的话的人"的态度');
});

// [PERSONA-SHIFT] 角色卡已按主人要求改成「默认不带刺、娇权重上调」（2026-10-29 重写）。
// 腹黑仍然必须在场（不能消失），但不再要求主导——阈值从 18.5% 降到 12%。
check('腹黑仍在场（占比 ≥12%，不要求主导）', () => {
  const seg = (h, n) => { const i = card.indexOf(h); const j = card.indexOf(n); return j - i; };
  const total = seg('## 脾气', '## 不知道的时候');
  const fu = seg('**腹黑**', '**腹诽**');
  const ratio = fu / total;
  assert.ok(ratio >= 0.12, `腹黑占比只有 ${(ratio * 100).toFixed(1)}%（<12%，快没了）`);
});

check('硬边界与工具说明不动', () => {
  assert.ok(card.includes('钱、账号、密码、别人的隐私，你一律不碰'), '硬边界丢了');
  assert.ok(card.includes('handoff_task'), '工具说明丢了');
  // 上限跟 config 走，不在这里另写一个数：2026-10-28 之前写死 6000，
  // 而 config.json 的 role.maxInjectChars 已是 12000 —— 两处不一致时，测试会误报"角色卡超限"。
  const cfg = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/config.json`, 'utf8'));
  const limit = Number(cfg.role?.maxInjectChars) || 6000;
  assert.ok(limit >= 1000 && limit <= 20000, `role.maxInjectChars 不在允许范围：${limit}`);
  assert.ok(card.length <= limit, `角色卡 ${card.length} 字 > role.maxInjectChars ${limit}`);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
