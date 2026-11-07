// 30 天加速生命模拟（纯模块级）：验证 SelfState / BeliefStore / MetaController 的守恒与行为边界。
//
// 这是蓝图 §7.3 的工程判据：任何机制若在 30 天模拟里发散、刷屏或状态越界，就不允许上线。
// 模拟不依赖 IO、模型与真实时间：固定 PRNG + 假时钟，结果可复现。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelfState, tickSelfState, applyAppraisal, applyEvent, needsPressure } from '../src/domain/mind/self-state.mjs';
import { createBeliefStore, observePerson, decayBeliefs, getPerson, relationshipWeight } from '../src/domain/mind/belief-store.mjs';
import { buildDecisionContext } from '../src/domain/mind/decision-context.mjs';
import { selectIntention, planFor } from '../src/domain/mind/meta-controller.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261103);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const clamp = (x) => Math.max(0, Math.min(1, x));

function bounded(label, value) {
  assert.ok(Number.isFinite(value), label + ' finite');
  assert.ok(value >= 0 && value <= 1, label + ' bounded: ' + value);
}

test('30 天模拟：状态有界、昼夜节律、意图可解释、无刷屏', () => {
  const start = Date.UTC(2026, 10, 1, 0, 0, 0);
  let now = start;
  let self = createSelfState({ at: now });
  let beliefs = createBeliefStore({ now });

  const people = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
  const groups = ['g1', 'g2', 'g3'];
  const seen = { received: 0, directed: 0, selected: {}, none: 0, actions: 0 };
  const energyTrail = [];
  const socialTrail = [];
  const trustTrail = {};
  let lastDirectedAt = 0;

  const hourOf = (ts) => new Date(ts).getUTCHours();
  const isNight = (ts) => hourOf(ts) >= 22 || hourOf(ts) < 7;
  const isSleeping = (ts) => hourOf(ts) >= 23 || hourOf(ts) < 7;

  for (let day = 0; day < 30; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      // 每小时 0–3 条消息（夜里少）
      let msgCount = 0;
      if (!isSleeping(now)) { if (rand() < 0.6) msgCount = 1; if (rand() < 0.2) msgCount += 1; } else if (rand() < 0.05) msgCount = 1;
      for (let i = 0; i < msgCount; i += 1) {
        const key = rand() < 0.5 ? 'private:' + pick(people) : 'group:' + pick(groups);
        const directed = rand() < 0.3;
        const valence = rand() < 0.7 ? 0.2 + rand() * 0.6 : -0.2 - rand() * 0.6;
        const personId = key.startsWith('private:') ? key.slice(8) : 'member_' + Math.floor(rand() * 4);
        self = applyAppraisal(self, {
          valence,
          arousal: 0.2 + rand() * 0.4,
          intensity: 0.5 + rand() * 0.5,
          emotions: valence >= 0 ? { joy: valence, affection: 0.4 } : { sadness: -valence, anger: -valence * 0.6 },
          source: key,
        }, { now });
        if (directed && rand() < 0.5) self = applyEvent(self, { type: 'social', intensity: 0.5 }, { now });
        beliefs = observePerson(beliefs, personId, {
          valence,
          reliability: 0.5 + rand() * 0.5,
          intensity: 0.4 + rand() * 0.6,
          topics: rand() < 0.3 ? ['话题' + Math.floor(rand() * 8)] : [],
          openLoop: rand() < 0.08 ? '答应的事' + Math.floor(rand() * 5) : undefined,
          contact: true,
          source: key,
        }, { now });
        seen.received += 1;
        if (directed) { seen.directed += 1; lastDirectedAt = now; }
        now += Math.floor(rand() * 10) * MIN;
      }

      // 每小时推进一次时间：睡觉/清醒
      now += HOUR;
      self = tickSelfState(self, { now, sleeping: isSleeping(now), activity: isSleeping(now) ? 'idle' : 'social' });
      beliefs = decayBeliefs(beliefs, { now });

      // 每小时做一次意图选择（影子）
      const key = rand() < 0.5 ? 'private:' + pick(people) : 'group:' + pick(groups);
      const personId = key.startsWith('private:') ? key.slice(8) : 'member_0';
      const ctx = buildDecisionContext({
        key, at: now,
        producers: { self: () => self, belief: () => getPerson(beliefs, personId, { now }) },
      });
      const decision = selectIntention(ctx, {
        now,
        directed: now - lastDirectedAt < 65 * MIN,
        idleMs: HOUR,
        night: isNight(now),
      });
      seen.actions += 1;
      if (decision.selected) {
        const type = decision.selected.type;
        seen.selected[type] = (seen.selected[type] || 0) + 1;
        // 最小效果回写：只验证守恒，不模拟真实执行
        if (type === 'rest') self = applyEvent(self, { type: 'rest', intensity: 0.6 }, { now });
        if (type === 'initiate') {
          self = applyEvent(self, { type: 'social', intensity: 0.5 }, { now });
          beliefs = observePerson(beliefs, personId, { valence: 0.3, contact: false }, { now });
        }
        if (type === 'reflect' || type === 'consolidate') self = applyEvent(self, { type: 'rest', intensity: 0.3 }, { now });
        assert.ok(decision.selected.reason.length > 0);
        assert.ok(planFor(decision.selected).length > 0);
      } else {
        seen.none += 1;
      }

      if (hour % 6 === 0) {
        bounded('energy', self.energy);
        bounded('socialHunger', self.socialHunger);
        bounded('valence', self.valence);
        bounded('mood', self.mood);
        energyTrail.push(self.energy);
        socialTrail.push(self.socialHunger);
        const p = getPerson(beliefs, 'alice', { now });
        bounded('trust', p.trust);
        bounded('affinity', p.affinity);
        trustTrail[day] = p.trust;
      }
    }
  }

  // 守恒：30 天后状态仍可解释
  assert.ok(self.energy >= 0 && self.energy <= 1);
  assert.ok(self.socialHunger >= 0 && self.socialHunger <= 1);
  assert.ok(relationshipWeight(getPerson(beliefs, 'alice', { now })) >= 0);

  // 昼夜节律：精力有高有低（不是恒 0.6，也不是永远见底）
  assert.ok(Math.min(...energyTrail) < 0.4, 'energy should dip');
  assert.ok(Math.max(...energyTrail) > 0.6, 'energy should recover');
  // 社交饥饿会上升也会被满足
  assert.ok(Math.max(...socialTrail) > 0.5, 'social hunger should rise');
  assert.ok(Math.min(...socialTrail) < 0.4, 'social hunger should be relieved');

  // 意图分布：回复/休息/主动/反思都出现过；主动不是主要动作（无刷屏）
  assert.ok(seen.selected.reply > 0, 'reply should happen');
  assert.ok(seen.selected.rest > 0, 'rest should happen');
  assert.ok(seen.selected.reflect > 0 || seen.selected.consolidate > 0, 'night reflection should happen');
  const initiateRatio = (seen.selected.initiate || 0) / seen.actions;
  assert.ok(initiateRatio < 0.35, 'initiate ratio too high: ' + initiateRatio);
  assert.ok(seen.none > 0, 'there should be moments with nothing to do');
  assert.ok(seen.actions >= 30 * 24);

  // 打印摘要（测试日志可读）
  console.log('[sim] received=' + seen.received + ' directed=' + seen.directed + ' actions=' + seen.actions);
  console.log('[sim] selected=' + JSON.stringify(seen.selected) + ' none=' + seen.none);
  console.log('[sim] energy min/max=' + Math.min(...energyTrail).toFixed(2) + '/' + Math.max(...energyTrail).toFixed(2)
    + ' social min/max=' + Math.min(...socialTrail).toFixed(2) + '/' + Math.max(...socialTrail).toFixed(2));
});
