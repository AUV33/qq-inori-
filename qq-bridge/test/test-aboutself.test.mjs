// [ABOUT-SELF] 「有人在说她」的本地判定（2026-10-30）
//
// 背景：群友说「这个ai好像确实可以」，后半句是「我看她的程序都是自己写然后存盘的」——**确实在说她**，
// 所以「这个 AI」必须继续算；要排除的是**明确在聊别人的 AI**（我的/我家的/别的/自己做的、别的 AI 的名字）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAboutSelf } from '../src/domain/leaves/inori-aboutself.js';

// 夹具：别名/错字显式传入——默认配置不含角色名（人格卡私有）。
const cfg = { aliases: ['小满', '满满', '阿满'], typo: ['小蛮'], otherAiNames: ['示例AI'] };

test('点名：别名与错字都算在说她', () => {
  assert.deepEqual(detectAboutSelf('@小满 谁', cfg), { hit: true, kind: 'alias', matched: '小满' });
  assert.equal(detectAboutSelf('小蛮又来了', cfg).kind, 'typo');
  assert.equal(detectAboutSelf('满满在吗', cfg).kind, 'alias');
});

test('确认为在说她的：「这个ai好像确实可以」必须继续命中', () => {
  const hit = detectAboutSelf('这个ai好像确实可以', cfg);
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'thirdParty');
  assert.equal(detectAboutSelf('那个AI画的图还行', cfg).hit, true);
});

test('第三人称：bot / 机器人 指代仍算', () => {
  assert.equal(detectAboutSelf('那个 bot 刚才说的不对', cfg).hit, true);
  assert.equal(detectAboutSelf('这机器人又卡了', cfg).hit, true);
  assert.equal(detectAboutSelf('她怎么又迟到了', cfg).hit, true);
});

test('明确在聊别人的 AI：我的/我家的/别的/自己做的 都不算', () => {
  for (const t of ['我的AI会写代码', '我家的机器人又抽风了', '别的AI都能做到', '自己做的AI就是不一样', '隔壁群那个机器人在刷屏']) {
    assert.equal(detectAboutSelf(t, cfg).hit, false, t);
  }
});

test('otherAiNames：提到别的 AI 的名字不算（除非同时点了她的名）', () => {
  assert.equal(detectAboutSelf('示例AI刚才说今晚调视觉模型', cfg).hit, false);
  assert.equal(detectAboutSelf('示例AI比小满还嘴硬', cfg).kind, 'alias');
});

test('点名优先于负向线索：同一句里既提别人又提她 → 算在说她', () => {
  assert.equal(detectAboutSelf('我的AI不如小满', cfg).kind, 'alias');
});

test('enabled=false 直接不判', () => {
  assert.equal(detectAboutSelf('@小满 在吗', { enabled: false }).hit, false);
});

test('空文本/非字符串不炸', () => {
  assert.equal(detectAboutSelf('', cfg).hit, false);
  assert.equal(detectAboutSelf(null, cfg).hit, false);
  assert.equal(detectAboutSelf(undefined, cfg).hit, false);
});

test('真实配置：config.json 里带了 otherAiNames（公开仓库不含 config.json，跳过）', async (t) => {
  const fs = await import('node:fs');
  const file = new URL('../config.json', import.meta.url);
  if (!fs.existsSync(file)) { t.skip('本机没有 config.json'); return; }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(j.socialV2.aboutSelf.otherAiNames), 'config 缺 otherAiNames');
  assert.ok(j.socialV2.aboutSelf.otherAiNames.includes('示例AI'));
});
