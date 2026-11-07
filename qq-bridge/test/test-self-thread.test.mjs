// test-self-thread.test.mjs · 宪章 §5.20：重逢时接上"刚才那根线"，离线久了要承认。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSelfThread, renderSelfThreadLine, SELF_THREAD_STALE_MS,
} from '../src/domain/mind/self-thread.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const kernel = (over = {}) => ({
  selfThread: { thought: '在想他上次说的那本书', at: T - 5 * 60 * 1000 },
  valence: 0.3, energy: 0.6, socialHunger: 0.4, attention: 0.7,
  goals: [{ text: '把手头的活做完', status: 'doing' }],
  affect: { joy: 0.3 }, ...over,
});

test('新鲜的线：stale=false，情绪/精力/挂念都在，渲染“刚才在想”', () => {
  const th = buildSelfThread({ kernelState: kernel(), now: T });
  assert.equal(th.stale, false);
  assert.equal(th.mood, '轻快');
  assert.equal(th.thoughtAgeMs, 5 * 60 * 1000);
  assert.deepEqual(th.activeGoals, ['把手头的活做完']);
  assert.equal(th.energy, 0.6);
  const line = renderSelfThreadLine(th);
  assert.match(line, /刚才在想的事/);
  assert.match(line, /那本书/);
  assert.match(line, /分钟前/);
});

test('离线久了：stale=true，渲染“上次离线时/别假装刚才还在想”', () => {
  const old = buildSelfThread({ kernelState: kernel({ selfThread: { thought: '在想那本书', at: T - SELF_THREAD_STALE_MS - 1 } }), now: T });
  assert.equal(old.stale, true);
  assert.equal(old.staleReason, 'too-long');
  const line = renderSelfThreadLine(old);
  assert.match(line, /上次离线时/);
  assert.match(line, /别假装刚才还在想/);
});

test('内核没有 selfThread 时：用最近 thoughts 兜底，仍按新鲜度渲染', () => {
  const th = buildSelfThread({ kernelState: null, selfState: {}, now: T, fallbackThought: '在想他说周末去不去', fallbackAt: T - 2 * 60 * 1000 });
  assert.equal(th.thought, '在想他说周末去不去');
  assert.equal(th.stale, false);
  assert.match(renderSelfThreadLine(th), /刚才在想的事/);
  assert.match(renderSelfThreadLine(th), /周末去不去/);
});

test('没有线：返回空串，不伪造', () => {
  const empty = buildSelfThread({ kernelState: { selfThread: { thought: '', at: 0 } }, now: T });
  assert.equal(empty.stale, true);
  assert.equal(empty.staleReason, 'no-thought');
  assert.equal(renderSelfThreadLine(empty), '');
  assert.equal(renderSelfThreadLine(null), '');
});

test('state-hub：能直接读 kernel-state/self-state 出连续自我卡片', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-thread-'));
  fs.writeFileSync(path.join(root, 'kernel-state.json'), JSON.stringify(kernel()), 'utf8');
  fs.writeFileSync(path.join(root, 'self-state.json'), JSON.stringify({ valence: 0.1, energy: 0.5 }), 'utf8');
  const hub = createStateHub({ root, now: () => T, log: () => {} });
  hub.load();
  const th = hub.getSelfThread();
  assert.equal(th.thought, '在想他上次说的那本书');
  assert.equal(th.stale, false);
  assert.ok(th.thoughtAgeMs > 0);
});

test('接线：app 暴露 getter，wake-prompt-service 渲染，prompt 接收该行', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const app = fs.readFileSync(path.join(HERE, '..', 'src/app.mjs'), 'utf8');
  assert.match(app, /getMindSelfThread/);
  const svc = fs.readFileSync(path.join(HERE, '..', 'src/domain/conversation/wake-prompt-service.mjs'), 'utf8');
  assert.match(svc, /renderSelfThreadLine/);
  assert.match(svc, /mindSelfThreadLine/);
  const wp = fs.readFileSync(path.join(HERE, '..', 'src/domain/persona/wake-prompt.mjs'), 'utf8');
  assert.match(wp, /mindSelfThreadLine/);
});
