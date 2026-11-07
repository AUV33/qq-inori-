// [FLOOR] 运行时轮次判断的回归锁：该不该接 / 等多久
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFloor, shouldWake, applyAdaptiveGuard, othersRepliedSoon, OTHERS_REPLIED_WINDOW_MS, FLOOR_DEFAULTS, ADAPTIVE_DEFAULTS } from '../src/domain/conversation/turn-taking.js';

const ctx = (o = {}) => ({ kind: 'group', reason: 'anyMessage', hour: 15, ...o });

test('私聊：几乎必回，且很快', () => {
  const f = decideFloor(ctx({ kind: 'private', reason: 'poke' }));
  assert.ok(f.reply >= 0.9);
  assert.ok(f.holdMs <= 500);
});

test('[PRIVATE-FLOOR] 私聊里「主人回过她」不算「已经有人接他」', () => {
  const f = decideFloor(ctx({ kind: 'private', reason: 'anyMessage', othersReplied: true }));
  assert.equal(Number(f.reply.toFixed(3)), 0.85, `私聊 reply 应保持 0.85（实际 ${f.reply}）`);
  assert.ok(!String(f.why).includes('已经有人接他'), '私聊不该再命中群规则');
  // 群聊行为不回归
  const g = decideFloor(ctx({ kind: 'group', reason: 'anyMessage', othersReplied: true }));
  assert.equal(Number(g.reply.toFixed(3)), Number((0.28 * 0.45).toFixed(3)));
  assert.ok(String(g.why).includes('已经有人接他'));
});

test('[PRIVATE-FLOOR] 私聊睡着只轻降（0.85×0.7），群里仍是 ×0.4', () => {
  const p = decideFloor(ctx({ kind: 'private', reason: 'anyMessage', asleep: true }));
  assert.equal(Number(p.reply.toFixed(3)), 0.595, `私聊睡着应约 0.595（实际 ${p.reply}）`);
  assert.ok(String(p.why).includes('睡着'));
  const g = decideFloor(ctx({ kind: 'group', reason: 'anyMessage', asleep: true }));
  assert.equal(Number(g.reply.toFixed(3)), Number((0.28 * 0.4).toFixed(3)));
});

test('群里点她：reply 高；即使她刚连说 3 条也不被按死', () => {
  const f = decideFloor(ctx({ reason: 'atMention', herRecentSends: 3, sinceHerSendMs: 10000, sameSenderBurst: 3 }));
  assert.equal(f.directed, true);
  assert.ok(f.reply >= 0.7, `被点名不该低于 0.7（实际 ${f.reply}）`);
});

test('群里没点她：默认就不该抢话', () => {
  const f = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 0 }));
  assert.ok(f.reply < 0.5);
  assert.ok(f.holdMs >= 2000);
});

test('addressee=别人 明显比 addressee=你 低', () => {
  const toOther = decideFloor(ctx({ reason: 'question', addressee: '别人' }));
  const toHer = decideFloor(ctx({ reason: 'question', addressee: '你' }));
  assert.ok(toOther.reply < toHer.reply * 0.5);
});

test('对方连发：等他说完（hold 变长）', () => {
  const calm = decideFloor(ctx({ reason: 'anyMessage', sameSenderBurst: 1 }));
  const burst = decideFloor(ctx({ reason: 'anyMessage', sameSenderBurst: 3 }));
  assert.ok(burst.holdMs > calm.holdMs);
  assert.ok(burst.reply < calm.reply);
});

test('她刚说过：reply 降、hold 升；3 分钟 ≥3 条再降', () => {
  const fresh = decideFloor(ctx({ reason: 'anyMessage' }));
  const just = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 1, sinceHerSendMs: 20000 }));
  const many = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 4, sinceHerSendMs: 100000 }));
  assert.ok(just.reply < fresh.reply);
  assert.ok(just.holdMs > fresh.holdMs);
  assert.ok(many.reply < fresh.reply);
});

test('凌晨/睡着：非点名继续降', () => {
  const day = decideFloor(ctx({ reason: 'anyMessage', hour: 15 }));
  const night = decideFloor(ctx({ reason: 'anyMessage', hour: 3 }));
  const asleep = decideFloor(ctx({ reason: 'anyMessage', asleep: true }));
  assert.ok(night.reply < day.reply);
  assert.ok(asleep.reply < day.reply);
});

test('上下界：attend/reply/hold 都不越界', () => {
  for (const kind of ['private', 'group']) {
    for (const reason of ['atMention', 'question', 'probability', 'continueChat']) {
      for (const hour of [3, 15]) {
        for (const asleep of [true, false]) {
          for (const addressee of ['', '你', '别人', '自己', '无']) {
            const f = decideFloor(ctx({ kind, reason, hour, asleep, addressee, herRecentSends: 5, sameSenderBurst: 5, sinceHerSendMs: 1000 }));
            assert.ok(f.attend >= 0 && f.attend <= 1);
            assert.ok(f.reply >= 0 && f.reply <= 0.95);
            assert.ok(f.holdMs >= 0 && f.holdMs <= FLOOR_DEFAULTS.maxHoldMs);
          }
        }
      }
    }
  }
});

test('shouldWake：点名必醒；低 reply 不醒；高 reply 按概率放行', () => {
  assert.equal(shouldWake({ reply: 0.05, directed: true }).wake, true);
  assert.equal(shouldWake({ reply: 0.1, directed: false }).wake, false);
  assert.equal(shouldWake({ reply: 0.9, directed: false }, { random: () => 0.0 }).wake, true);
  assert.equal(shouldWake({ reply: 0.9, directed: false }, { random: () => 0.999 }).wake, false);
  assert.equal(shouldWake(null).wake, true, '没有判断结果时照常唤醒');
});

// ── 2026-10-28 完善：结构信号 / 实测间隔 / 自适应阈值 ──────────────────────────

test('结构信号：这条直接回她（replyToHer）时 reply 抬高，不再只靠文本 judge', () => {
  const plain = decideFloor(ctx({ reason: 'anyMessage' }));
  const replied = decideFloor(ctx({ reason: 'anyMessage', replyToHer: true }));
  assert.ok(replied.reply > plain.reply, `直接回她应当更高（${plain.reply} → ${replied.reply}）`);
  assert.ok(replied.reply >= 0.8);
  assert.match(replied.why, /直接回她/);
});

test('实测间隔分位：中位 90s 时，60 秒前说过也算"刚说过"（比固定 45s 更宽）', () => {
  const fixed = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 1, sinceHerSendMs: 60000 }));
  const measured = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 1, sinceHerSendMs: 60000, gapP50Ms: 90000, gapP75Ms: 180000 }));
  assert.ok(measured.reply < fixed.reply, `实测口径下应当更低（${fixed.reply} → ${measured.reply}）`);
  assert.match(measured.why, /实测中位/);
});

test('实测间隔分位：中位 10s 时，30 秒前说过不算"刚说过"（比固定 45s 更窄）', () => {
  const fixed = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 1, sinceHerSendMs: 30000 }));
  const measured = decideFloor(ctx({ reason: 'anyMessage', herRecentSends: 1, sinceHerSendMs: 30000, gapP50Ms: 10000, gapP75Ms: 20000 }));
  assert.ok(measured.reply > fixed.reply, `实测口径下应当更高（${fixed.reply} → ${measured.reply}）`);
  assert.doesNotMatch(measured.why, /实测中位/);
});

test('自适应阈值：被接住率高 → 阈值降；低 → 阈值升；样本不足保持默认', () => {
  const high = decideFloor(ctx({ hitRate: 0.8, hitSamples: 20 }));
  const low = decideFloor(ctx({ hitRate: 0.05, hitSamples: 20 }));
  const few = decideFloor(ctx({ hitRate: 0.8, hitSamples: 2 }));
  assert.ok(high.minReply < FLOOR_DEFAULTS.minReply, `高接住率应降阈值（${high.minReply}）`);
  assert.ok(low.minReply > FLOOR_DEFAULTS.minReply, `低接住率应升阈值（${low.minReply}）`);
  assert.equal(few.minReply, FLOOR_DEFAULTS.minReply, '小样本不调阈值');
  assert.ok(high.minReply >= FLOOR_DEFAULTS.minReplyFloor);
  assert.ok(low.minReply <= FLOOR_DEFAULTS.minReplyCeil);
});

test('[THRESHOLD-CAP] 阈值上限必须低于「群里没点她」的日常基数 0.28', () => {
  const casual = decideFloor(ctx({ reason: 'anyMessage' }));
  assert.equal(Number(casual.reply.toFixed(2)), 0.28);
  assert.ok(FLOOR_DEFAULTS.minReplyCeil < casual.reply,
    `上限 ${FLOOR_DEFAULTS.minReplyCeil} 必须低于日常基数 ${casual.reply}，否则 hitRate=0 时她结构上不可能开口`);
  // hitRate=0（被接住 0%）时阈值落在上限，但仍低于日常基数
  const locked = decideFloor(ctx({ hitRate: 0, hitSamples: 51 }));
  assert.equal(Number(locked.minReply.toFixed(2)), 0.26);
  assert.ok(locked.reply > locked.minReply, `日常消息应能过阈值（${locked.reply} > ${locked.minReply}）`);
  // hitRate=1 时落到下限
  const ideal = decideFloor(ctx({ hitRate: 1, hitSamples: 51 }));
  assert.equal(Number(ideal.minReply.toFixed(2)), 0.12);
});

test('[OTHERS-REPLIED] 「有人接了她这一句」只算发完 120 秒内', () => {
  const send = 1_000_000;
  assert.equal(OTHERS_REPLIED_WINDOW_MS, 120_000);
  assert.equal(othersRepliedSoon([send + 30_000], send), true, '30 秒内算接');
  assert.equal(othersRepliedSoon([send + 120_000], send), true, '整 120 秒算接');
  assert.equal(othersRepliedSoon([send + 121_000], send), false, '121 秒不算接');
  assert.equal(othersRepliedSoon([send - 60_000, send + 30_000], send), true, '只看她之后的第一条');
  assert.equal(othersRepliedSoon([send - 60_000], send), false, '只有之前的消息不算');
  assert.equal(othersRepliedSoon([send + 30_000], null), false, '没发过言不算');
});

test('shouldWake 用 floor.minReply：同一条 reply 因阈值不同而结果不同', () => {
  const floor = decideFloor(ctx({ hitRate: 0.8, hitSamples: 20 }));
  // 构造一个刚好卡在默认 0.22 与自适应阈值之间的 reply
  const mid = Math.max(0.2, (FLOOR_DEFAULTS.minReply + floor.minReply) / 2);
  assert.equal(shouldWake({ ...floor, reply: mid }, { random: () => 0 }).wake, true, '自适应阈值更低时应放行');
  assert.equal(shouldWake({ ...floor, reply: mid, minReply: 0.5 }, { random: () => 0 }).wake, false, '显式阈值优先');
});


// ── 2026-10-28 第 2 步：自适应阈值阀门（长期 metrics + 突变保护 + 开关）──────────

test('阀门：adaptive=false 时不采纳任何值', () => {
  const r = applyAdaptiveGuard({ prevRate: 0.3, newRate: 0.9, samples: 20, enabled: false });
  assert.equal(r.rate, null);
  assert.equal(r.reason, 'disabled');
  assert.equal(r.blocked, true);
});

test('阀门：样本不足（<5）沿用上次生效值，不拿噪声改阈值', () => {
  const r = applyAdaptiveGuard({ prevRate: 0.4, prevSamples: 12, newRate: 0.05, samples: 3 });
  assert.equal(r.rate, 0.4);
  assert.equal(r.n, 12);
  assert.equal(r.reason, 'samples');
  const first = applyAdaptiveGuard({ newRate: 0.05, samples: 3 });
  assert.equal(first.rate, null, '还没有历史值时保持固定阈值');
});

test('阀门：首次有足够样本时直接采纳', () => {
  const r = applyAdaptiveGuard({ newRate: 0.6, samples: 10 });
  assert.equal(r.rate, 0.6);
  assert.equal(r.n, 10);
  assert.equal(r.blocked, false);
});

test('阀门：与上次相差 >20pp 视为突变，本轮不采纳', () => {
  const r = applyAdaptiveGuard({ prevRate: 0.4, prevSamples: 8, newRate: 0.9, samples: 20 });
  assert.equal(r.rate, 0.4);
  assert.equal(r.reason, 'jump');
  assert.equal(r.from, 0.4);
  assert.equal(r.to, 0.9);
});

test('阀门：小幅变化正常采纳，且 rate 夹在 0..1', () => {
  assert.equal(applyAdaptiveGuard({ prevRate: 0.4, prevSamples: 8, newRate: 0.5, samples: 20 }).rate, 0.5);
  assert.equal(applyAdaptiveGuard({ newRate: 1.7, samples: 20 }).rate, 1);
  assert.equal(applyAdaptiveGuard({ newRate: -0.3, samples: 20 }).rate, 0);
  assert.equal(ADAPTIVE_DEFAULTS.maxJump, 0.2);
});

// ── 2026-10-28 self-tune：她自己调的参数（优先于自适应/默认）────────────────

test('self-tune：minReplyOverride 覆盖自适应与默认，且再夹一次边界', () => {
  const base = decideFloor(ctx({ reason: 'anyMessage' }));
  const low = decideFloor(ctx({ reason: 'anyMessage', minReplyOverride: 0.1 }));
  const high = decideFloor(ctx({ reason: 'anyMessage', minReplyOverride: 0.55, hitRate: 0.9, hitSamples: 20 }));
  assert.equal(base.minReply, FLOOR_DEFAULTS.minReply);
  assert.equal(low.minReply, 0.1);
  assert.equal(high.minReply, 0.55, '她自己设的值优先于自适应');
  assert.equal(decideFloor(ctx({ minReplyOverride: 9 })).minReply, 0.6, '越界夹到上界');
  assert.equal(decideFloor(ctx({ minReplyOverride: -1 })).minReply, 0.05, '越界夹到下界');
  assert.match(high.why, /她自己把阈值调到/);
});

test('self-tune：holdScale 缩放停顿，夹在 0.5–2 且不超过上限', () => {
  const normal = decideFloor(ctx({ reason: 'anyMessage' }));
  const eager = decideFloor(ctx({ reason: 'anyMessage', holdScale: 0.5 }));
  const slow = decideFloor(ctx({ reason: 'anyMessage', holdScale: 2 }));
  const crazy = decideFloor(ctx({ reason: 'anyMessage', holdScale: 10 }));
  assert.equal(eager.holdMs, Math.round(normal.holdMs * 0.5));
  assert.equal(slow.holdMs, Math.min(FLOOR_DEFAULTS.maxHoldMs, normal.holdMs * 2));
  assert.equal(crazy.holdMs, Math.min(FLOOR_DEFAULTS.maxHoldMs, normal.holdMs * 2), '越界按 2 倍算');
  assert.match(slow.why, /停顿 ×2/);
});
