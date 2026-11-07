// wake-stash 回归锁：三处调用点曾各写一份，行为分叉是真实 bug 源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stashWakeReason, MAX_PENDING_WAKE_REASONS } from '../src/domain/conversation/wake-stash.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('去重：同一 reason+seq 不重复入队', () => {
  const st = { lastUnreadSeq: 7 };
  assert.equal(stashWakeReason(st, 'atMention').added, true);
  assert.equal(stashWakeReason(st, 'atMention').added, false);
  assert.equal(st.pendingWakeReasons.length, 1);
  assert.deepEqual(st.pendingWakeReasons[0], { reason: 'atMention', seq: 7 });
  assert.equal(stashWakeReason(st, 'atMention').seq, 7);
});

test('seq 变化后是新的一次唤醒，应入队', () => {
  const st = { lastUnreadSeq: 1, pendingWakeReasons: null };
  stashWakeReason(st, 'question');
  st.lastUnreadSeq = 2;
  const r = stashWakeReason(st, 'question');
  assert.equal(r.added, true);
  assert.equal(r.seq, 2);
  assert.equal(st.pendingWakeReasons.length, 2);
});

test('有界队列：洪峰下最多保留 20 条，且丢的是最旧的', () => {
  const st = { lastUnreadSeq: 0 };
  for (let i = 0; i < 50; i += 1) {
    st.lastUnreadSeq = i;
    stashWakeReason(st, 'reason-' + i);
  }
  assert.equal(st.pendingWakeReasons.length, MAX_PENDING_WAKE_REASONS);
  assert.equal(st.pendingWakeReasons[0].reason, 'reason-30');
  assert.equal(st.pendingWakeReasons.at(-1).reason, 'reason-49');
});

test('非法状态安全返回，不抛', () => {
  assert.deepEqual(stashWakeReason(null, 'x'), { seq: 0, added: false });
  assert.doesNotThrow(() => stashWakeReason({}, 'x'));
});

test('结构：三处重复实现已收敛到单一模块', () => {
  for (const f of ['wake-sender.mjs', 'wake-schedule.mjs']) {
    const t = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'conversation', f), 'utf8');
    assert.match(t, /from '\.\/wake-stash\.mjs'/, `${f} 应引用共享实现`);
    assert.ok(!t.includes('st.pendingWakeReasons.push('), `${f} 不应再自己 push`);
  }
});
