// StateHub 契约测试：单写收口 / 原子持久化 / 派生接口 / 迁移 / 损坏容错。
// 全部使用临时目录，不触碰真实 data/state。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateHub, STATE_HUB_FILE } from '../src/domain/mind/state-hub.mjs';

function makeHub(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-hub-'));
  const hub = createStateHub({
    root: dir,
    legacyEmotionFile: path.join(dir, 'emotion-vector.json'),
    ...over,
  });
  return { hub, dir };
}

test('新建：load 得到完整状态（self/affect/beliefs/lessons）', () => {
  const { hub } = makeHub();
  const s = hub.load();
  assert.equal(typeof s.self.energy, 'number');
  assert.ok(s.affect && typeof s.affect.keys === 'object');
  assert.ok(s.beliefs && typeof s.beliefs.people === 'object');
  assert.ok(Array.isArray(s.lessons));
  assert.equal(hub.status().v, 2);
});

test('apply：praise 提升效价与 joy，且不抛错', () => {
  const { hub } = makeHub({ now: () => 1_000_000 });
  const before = hub.state.self;
  const after = hub.apply({ type: 'praise', intensity: 1 });
  assert.ok(after.valence >= before.valence);
  assert.ok(after.affect.joy >= before.affect.joy);
});

test('tick：睡眠推进恢复精力（按真实 elapsed）', () => {
  let t = 1_000_000;
  const { hub } = makeHub({ now: () => t });
  hub.load();
  hub.apply({ type: 'effort', intensity: 1 });
  const low = hub.state.self.energy;
  t += 3 * 3600 * 1000;
  const after = hub.tick({ sleeping: true });
  assert.ok(after.energy > low, `睡眠应恢复精力：${low} -> ${after.energy}`);
});

test('flush：原子落盘，重新加载状态一致', async () => {
  const { hub, dir } = makeHub({ now: () => 5_000_000 });
  hub.load();
  hub.apply({ type: 'conflict', intensity: 1 });
  const before = hub.snapshot().self.valence;
  assert.equal(await hub.flush(), true);
  assert.ok(fs.existsSync(path.join(dir, STATE_HUB_FILE)), '应写出 state-hub.json');

  const again = createStateHub({ root: dir, legacyEmotionFile: path.join(dir, 'emotion-vector.json'), now: () => 5_000_000 });
  assert.equal(again.load().self.valence, before);
});

test('maybeFlush：节流期内跳过，force 时写入', async () => {
  const { hub } = makeHub({ minFlushIntervalMs: 100000 });
  hub.load();
  assert.equal(await hub.flush(), true);
  hub.apply({ type: 'social', intensity: 1 });
  assert.equal(await hub.maybeFlush(), false, '节流期内不应写盘');
  assert.equal(await hub.maybeFlush(true), true, 'force 应写盘');
});

test('affect + replyTone + memorySalience：都在 [0,1] 且随情绪变化', () => {
  const { hub } = makeHub();
  hub.load();
  hub.observeAffect('private:1', { affect: '亲近', confidence: 1 });
  const tone = hub.replyTone('private:1');
  for (const k of ['warmth', 'energy', 'patience', 'openness']) {
    assert.ok(tone[k] >= 0 && tone[k] <= 1, `${k} 应在 [0,1]，实际 ${tone[k]}`);
  }
  const sal = hub.memorySalience('private:1');
  assert.ok(sal.salience >= 0 && sal.salience <= 1);
});

test('observePerson：信念/未解之事/关系权重可读写', () => {
  const { hub } = makeHub();
  hub.load();
  hub.observePerson('u1', { contact: true, valence: 0.8, openLoop: { topic: '还没回她的问题', urgency: 0.9 } });
  const person = hub.getBelief('u1');
  assert.ok(person.affinity > 0.5);
  const loops = hub.openLoops('u1');
  assert.equal(loops.length, 1);
  assert.ok(hub.relationship('u1') > 0 && hub.relationship('u1') <= 1);
});

test('selectIntention：被直接点名时优先 reply', () => {
  const { hub } = makeHub();
  hub.load();
  const r = hub.selectIntention({ directed: true, unreadCount: 1, scene: 'private' });
  assert.ok(r.selected, '应有选中意图');
  assert.equal(r.selected.type, 'reply');
  assert.ok(Array.isArray(hub.planForIntention(r.selected)));
});

test('addLesson：写入并受上限约束', () => {
  const { hub } = makeHub();
  hub.load();
  hub.addLesson({ text: '群聊里别抢话', weight: 0.9, source: 'reflection' });
  assert.equal(hub.lessons().length, 1);
  assert.equal(hub.lessons()[0].text, '群聊里别抢话');
});

test('迁移：无 state-hub 时从旧 self-state/beliefs 播种', () => {
  const { hub, dir } = makeHub();
  fs.writeFileSync(path.join(dir, 'self-state.json'), JSON.stringify({ at: 1_000, energy: 0.2, sleepDebt: 0.9 }), 'utf8');
  fs.writeFileSync(path.join(dir, 'beliefs.json'), JSON.stringify({ at: 1_000, people: { u9: { id: 'u9', trust: 0.9, affinity: 0.8 } } }), 'utf8');
  const s = hub.load();
  assert.ok(Math.abs(s.self.energy - 0.2) < 1e-6, `应迁移旧精力，实际 ${s.self.energy}`);
  assert.ok(s.beliefs.people.u9, '应迁移旧信念');
});

test('损坏 state-hub.json：回退空态，不抛错', () => {
  const { hub, dir } = makeHub();
  fs.writeFileSync(path.join(dir, STATE_HUB_FILE), '{"v":2,', 'utf8');
  const s = hub.load();
  assert.equal(typeof s.self.energy, 'number');
  assert.ok(Array.isArray(s.lessons));
});
