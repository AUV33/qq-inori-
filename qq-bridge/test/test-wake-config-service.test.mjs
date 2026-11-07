// wake-config-service 金标：默认唤醒配置 / 只刷新 default 会话 / speakerIds 清洗。
// 2026-11-02 抓到的回归：抽离时 `\s`/`\d` 转义丢了，多位数 QQ 号被当成非法值全部丢掉，
// 「指定发言人才唤醒」静默失效——这类只能靠单测钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeConfig } from '../src/domain/conversation/wake-config-service.mjs';

function makeCtx(overrides = {}) {
  const conversations = new Map();
  const saves = [];
  const ctx = {
    cfg: { socialV2: { wake: {} } },
    getSocialV2: () => ({ conversations }),
    saveSocialV2State: () => saves.push(Date.now()),
    ...overrides,
  };
  const svc = createWakeConfig(ctx);
  return { svc, conversations, saves };
}

test('normalizeSpeakerIdsV2：多位数 QQ 号、中英逗号/空白分隔、去重、上限 20', () => {
  const { svc } = makeCtx();
  assert.deepEqual(svc.normalizeSpeakerIdsV2('123456,789012 345'), ['123456', '789012', '345']);
  assert.deepEqual(svc.normalizeSpeakerIdsV2('123456，123456'), ['123456']);
  assert.deepEqual(svc.normalizeSpeakerIdsV2(['007', '0', 'x', '42']), ['42'], '前导零/非数字要丢');
  const many = Array.from({ length: 30 }, (_, i) => String(1000 + i)).join(',');
  assert.equal(svc.normalizeSpeakerIdsV2(many).length, 20);
  assert.deepEqual(svc.normalizeSpeakerIdsV2(null), []);
  assert.deepEqual(svc.normalizeSpeakerIdsV2(''), []);
});

test('defaultWakeConfigV2：无限潜水时没有 sleepUntil，有限时落在推荐区间内', () => {
  const { svc } = makeCtx();
  const infinite = svc.defaultWakeConfigV2();
  assert.equal(infinite.mode, 'diving');
  assert.equal(infinite.infinite, true);
  assert.equal(infinite.sleepUntil, null);
  assert.equal(infinite.confirmedBy, 'default');
  assert.equal(infinite.triggers.anyMessage, false, '潜水模式不因任意消息唤醒');
  assert.equal(infinite.triggers.atMention, true);
  assert.equal(infinite.triggers.speakerIds.length, 0);

  const finite = makeCtx({
    cfg: {
      socialV2: {
        wake: {
          recommendedDefaultInfinite: false,
          recommendedSleepMinMs: 1000,
          recommendedSleepMaxMs: 2000,
          recommendedProbability: 0.5,
        },
      },
    },
  }).svc.defaultWakeConfigV2();
  const until = Date.parse(finite.sleepUntil);
  assert.equal(finite.infinite, false);
  assert.ok(until - Date.now() >= 900 && until - Date.now() <= 2100, `sleepUntil 应在推荐区间内，实际 ${finite.sleepUntil}`);
  assert.equal(finite.triggers.probability, 0.5);
});

test('defaultWakeConfigV2：active 默认模式会开 anyMessage，硬上下限夹住随机时长', () => {
  const { svc } = makeCtx({
    cfg: {
      socialV2: {
        wake: {
          defaultMode: 'active',
          recommendedDefaultInfinite: false,
          recommendedSleepMinMs: 1,
          recommendedSleepMaxMs: 2,
          sleepMinMs: 60000,
          sleepMaxMs: 90000,
        },
      },
    },
  });
  const conf = svc.defaultWakeConfigV2();
  assert.equal(conf.mode, 'active');
  assert.equal(conf.triggers.anyMessage, true);
  const delta = Date.parse(conf.sleepUntil) - Date.now();
  assert.ok(delta >= 59000 && delta <= 91000, `硬上下限应生效，实际 ${delta}ms`);
});

test('refreshDefaultWakeConfigV2：只覆盖 confirmedBy=default，保留计数', () => {
  const { svc } = makeCtx();
  const def = { wakeConfig: { confirmedBy: 'default', lastWakeAt: 111, wakeCount: 3, noActionCount: 2, confirmedAt: 9 } };
  assert.equal(svc.refreshDefaultWakeConfigV2(def), true);
  assert.equal(def.wakeConfig.confirmedBy, 'default');
  assert.equal(def.wakeConfig.lastWakeAt, 111);
  assert.equal(def.wakeConfig.wakeCount, 3);
  assert.equal(def.wakeConfig.noActionCount, 2);
  assert.equal(def.wakeConfig.confirmedAt, 9);

  const ai = { wakeConfig: { confirmedBy: 'ai', lastWakeAt: 5 } };
  assert.equal(svc.refreshDefaultWakeConfigV2(ai), false);
  assert.deepEqual(ai.wakeConfig, { confirmedBy: 'ai', lastWakeAt: 5 });
  assert.equal(svc.refreshDefaultWakeConfigV2(null), false);
  assert.equal(svc.refreshDefaultWakeConfigV2({}), false);
});

test('refreshAllDefaultWakeConfigsV2：有变化才落盘，且只动默认会话', () => {
  const { svc, conversations, saves } = makeCtx();
  const a = { wakeConfig: { confirmedBy: 'default', wakeCount: 1 } };
  const b = { wakeConfig: { confirmedBy: 'owner', wakeCount: 9 } };
  conversations.set('group:1', a);
  conversations.set('private:2', b);
  assert.equal(svc.refreshAllDefaultWakeConfigsV2(), true);
  assert.equal(saves.length, 1);
  assert.equal(a.wakeConfig.wakeCount, 1);
  assert.deepEqual(b.wakeConfig, { confirmedBy: 'owner', wakeCount: 9 });

  // 再跑一次：都已经是 default 配置，但内容仍会被重写 → changed 仍为 true（语义是“刷新过默认会话”）
  assert.equal(svc.refreshAllDefaultWakeConfigsV2(), true);
  const empty = makeCtx();
  assert.equal(empty.svc.refreshAllDefaultWakeConfigsV2(), false);
  assert.equal(empty.saves.length, 0);
});
