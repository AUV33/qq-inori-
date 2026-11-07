// [PEER-BOT] 同类识别：名单里的「人」是别的 AI 时，别按人熟络、别互相客套。
//
// 2026-10-29 00:07 群 123456789：示例bot（另一个 bot）「小满，正式打个招呼」「别嫌我烦就行」，
// 她回「行 记住你了」；群里当场喊「唉wc了又开始人机互吹了」。这里锁三件事：
//   ① 归一/识别是纯函数（不传就是旧行为）；② 那行提示只在真的认出来时出现；
//   ③ 接线不被后续重构悄悄拆掉（wake-sender 注入 + 成员档案标 bot + app.mjs 依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeBotIds, pickTalkingPeers, renderPeerBotLine } from '../src/domain/social/peer-bots.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('normalizeBotIds：数组/单值/逗号串都归一成去重字符串', () => {
  assert.deepEqual(normalizeBotIds([10002, ' 10002 ', '']), ['10002']);
  assert.deepEqual(normalizeBotIds(10002), ['10002']);
  assert.deepEqual(normalizeBotIds('1, 2,1'), ['1', '2']);
  assert.deepEqual(normalizeBotIds(null), []);
  assert.deepEqual(normalizeBotIds([]), []);
});

test('pickTalkingPeers：只认名单里的、非自己的、有文字的消息，按人去重', () => {
  const msgs = [
    { userId: '10002', sender: '示例bot', text: '在，刚翻完小说' },
    { userId: '10001', sender: '主人', text: '她怎么又不说话了' },
    { userId: '10002', sender: '示例bot', text: '我也没兴趣吵' },
    { userId: '10002', sender: '示例bot', text: '   ' },
    { userId: '10002', sender: '示例bot', text: '自己', isSelf: true },
  ];
  const peers = pickTalkingPeers([10002], msgs);
  assert.deepEqual(peers, [{ id: '10002', name: '示例bot' }], '同一人只出现一次，主人不是 bot 不进');
  assert.deepEqual(pickTalkingPeers([], msgs), [], '名单空 → 旧行为');
  assert.deepEqual(pickTalkingPeers([10002], [{ userId: '999', sender: '别人', text: 'hi' }]), []);
});

test('pickTalkingPeers：limit 只认最近这几条（久没说话的 bot 不算正在说话）', () => {
  const msgs = [
    { userId: '10002', sender: '示例bot', text: '打个招呼' },
    { userId: '1', sender: '甲', text: 'a' },
    { userId: '2', sender: '乙', text: 'b' },
  ];
  assert.deepEqual(pickTalkingPeers([10002], msgs, { limit: 2 }), []);
  assert.equal(pickTalkingPeers([10002], msgs, { limit: 3 }).length, 1);
});

test('renderPeerBotLine：有同类才出，写清「别互相客套」且带名字/QQ；没有就空串', () => {
  assert.equal(renderPeerBotLine([]), '');
  assert.equal(renderPeerBotLine(null), '');
  const line = renderPeerBotLine([{ id: '10002', name: '示例bot' }]);
  assert.ok(line.includes('示例bot'), '要能认出是谁');
  assert.ok(line.includes('10002'), '带 QQ 号，避免同名误伤');
  assert.ok(line.includes('也是 AI'), '点明同类身份');
  assert.ok(line.includes('客套') && line.includes('别跟它'), '明确别互相客套');
});

test('接线：wake-sender 注入同类行 + 成员档案标 bot + app.mjs 传依赖', () => {
  const sender = read('../src/domain/conversation/wake-sender.mjs');
  assert.ok(sender.includes('pickTalkingPeers(botIds'), 'wake-sender 必须用已知 bot 名单识别当前说话的同类');
  assert.ok(sender.includes('renderPeerBotLine(peers)'), 'wake-sender 必须注入同类提示');
  assert.ok(sender.includes('botIds: cfg.socialV2?.knownBots'), '成员档案必须知道谁是 bot');

  const members = read('../src/domain/leaves/inori-groupmembers.js');
  assert.ok(members.includes('renderPersonLines(key, m, { isBot })'), '成员档案必须把 isBot 传下去');

  const people = read('../src/domain/leaves/inori-people.js');
  assert.ok(/if \(opts && opts\.isBot\) return \[/.test(people), 'bot 不该被推「可以熟一点」');

  const app = read('../src/app.mjs');
  for (const dep of ['pickTalkingPeers,', 'renderPeerBotLine,']) {
    assert.ok(app.includes(dep), `app.mjs 必须把 ${dep} 注入 wake-sender`);
  }
});
