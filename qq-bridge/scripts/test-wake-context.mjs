import { readBridgeSource } from './lib/bridge-source.mjs';
// test-wake-context.mjs · 唤醒上下文优化接线锁（触发器可见 + 未读没带完）
import assert from 'node:assert';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

// 快照实现已抽到 src/wake-snapshot.mjs（S2-3）；合集里已包含它，这里只取合集。
const src = readBridgeSource();

check('叫醒她的那条单独可见（[WAKE-TRIGGER]）', () => {
  assert.ok(src.includes('[WAKE-TRIGGER]'), '没有 [WAKE-TRIGGER]');
  assert.ok(src.includes('packet.trigger = compactMsg(lastUnread)') || src.includes('packet.trigger = compactModelMessage(lastUnread)'), '没有 trigger 赋值');
  assert.ok(src.includes('includedSeqs'), '没有去重判断（可能重复带触发条）');
});

check('未读没带完会被明确告知', () => {
  assert.ok(src.includes('packet.omitted'), '没有 omitted 计数');
  assert.ok(src.includes('【未读没带完】'), '没有对她说“没带完”');
  assert.ok(src.includes('wakeSnapshot.partial'), '没有 partial 分支');
});

check('唤醒快照有观测日志', () => {
  assert.ok(src.includes('[wake-snapshot]'), '没有 [wake-snapshot] 日志');
  assert.ok(src.includes('没带='), '日志缺 omitted 字段');
});

check('说完话自动确认未读（[AUTO-ACK]）', () => {
  assert.ok(src.includes('[AUTO-ACK]'), '没有 [AUTO-ACK]');
  assert.ok(src.includes('autoAckAfterSend(key, ackCeilForReply(key, replyToMessageId))'), '发送后没有调用带引用上限的自动确认');
  assert.ok(src.includes('st.pendingAckSeq'), '没有记录本次唤醒看到哪');
});

check('有未读时 recent 不塞已读旧账（[SNAPSHOT-NO-BACKLOG]）', () => {
  assert.ok(src.includes('[SNAPSHOT-NO-BACKLOG]'), '没有 [SNAPSHOT-NO-BACKLOG]');
  assert.ok(src.includes('m.seq < oldestUnread'), 'recent 仍可能带已读旧消息');
});

check('引用较早消息时只确认到被引用那条（[ACK-QUOTE]）', () => {
  assert.ok(src.includes('[ACK-QUOTE]'), '没有 [ACK-QUOTE]');
  assert.ok(src.includes('ackCeilForReply'), '没有引用上限计算');
  assert.ok(src.includes('Math.min(pending, ceilingSeq)'), '没有把 ack 上限夹到被引用 seq');
});

check('启动恢复 reverse 时 owner lane 归一成 base key（[OWNER-LANE-FIX]）', () => {
  assert.ok(src.includes('[OWNER-LANE-FIX]'), '没有 [OWNER-LANE-FIX]');
  assert.ok(src.includes("reverse.set(sessionId, String(key).endsWith('#owner')"), 'boot reverse 仍存 #owner');
});

check('快照的 recent 不包含她自己（[SNAPSHOT-NO-SELF]）', () => {
  assert.ok(src.includes('[SNAPSHOT-NO-SELF]'), '没有 [SNAPSHOT-NO-SELF]');
  assert.ok(src.includes('!m.isSelf'), 'recent 没排除 isSelf');
});

check('会话跑太久会在唤醒间隙轮换（[SESSION-ROTATE]）', () => {
  assert.ok(src.includes('[SESSION-ROTATE]'), '没有 [SESSION-ROTATE]');
  assert.ok(src.includes('maxSessionTurns'), '没有回合阈值配置');
  assert.ok(src.includes('stRot.sessionTurns'), '没有回合计数');
  assert.ok(src.includes('retireSession(key);'), '没有退役旧会话');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
