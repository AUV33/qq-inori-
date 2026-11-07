// [WAIT-NEXT] 要不要等对方下一句再回：场景/话题判断的回归锁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumeMoreComing, cleanIncoming } from '../src/domain/conversation/reply-pace.js';

test('cleanIncoming 剥掉引用块/@/CQ 码', () => {
  assert.equal(cleanIncoming('[引用 某人：你好]@小满 今天有事，'), '今天有事，');
  assert.equal(cleanIncoming('[CQ:image,file=x] 在吗'), '在吗');
});

test('句子没说完（逗号/省略号结尾）→ 等下一句，私聊等更久', () => {
  const p = assumeMoreComing({ kind: 'private', text: '我今天遇到一件事，' });
  const g = assumeMoreComing({ kind: 'group', text: '我今天遇到一件事，' });
  assert.equal(p.wait, true);
  assert.ok(p.waitMs >= g.waitMs, '私聊应比群聊更有耐心');
  assert.match(p.why, /没说完/);
});

test('以连接词结尾（然后/而且/就是）→ 等', () => {
  for (const t of ['然后', '而且我觉得', '就是那个', '因为']) {
    assert.equal(assumeMoreComing({ kind: 'private', text: t }).wait, true, t);
  }
});

test('完整问句 → 立刻回，不等', () => {
  for (const t of ['你在吗？', '今天几号', '这个你懂吗', '你吃了吗']) {
    assert.equal(assumeMoreComing({ kind: 'private', text: t }).wait, false, t);
  }
});

test('严肃/情绪话题 → 不等，马上接', () => {
  for (const t of ['我很难过', '我有点想哭', '对不起', '我们是不是吵架了', '我妈病了']) {
    const p = assumeMoreComing({ kind: 'private', text: t });
    assert.equal(p.wait, false, t);
    assert.match(p.why, /不让人等/);
  }
  assert.equal(assumeMoreComing({ kind: 'group', text: '随便说说', topic: 'emotional' }).wait, false);
});

test('对方在连发（15 秒内 ≥2 条）→ 等他把话说完', () => {
  const p = assumeMoreComing({ kind: 'private', text: '那个事情我跟你讲', senderRecent15s: 3 });
  assert.equal(p.wait, true);
  assert.match(p.why, /连发/);
});

test('极短消息（≤4 字）→ 当成没说完，等一下；但语气词/应答不算', () => {
  assert.equal(assumeMoreComing({ kind: 'private', text: '我跟你说' }).wait, true);
  for (const t of ['哈哈', '嗯', '好', '在吗', '草', '233']) {
    assert.equal(assumeMoreComing({ kind: 'private', text: t }).wait, false, t);
  }
});

test('群聊普通完整句 → 不等（群里不占着等）', () => {
  assert.equal(assumeMoreComing({ kind: 'group', text: '今天天气不错' }).wait, false);
  assert.equal(assumeMoreComing({ kind: 'group', text: '今天天气不错' }).why, '群聊不占着等');
});

test('waitMs 有上限（≤12000）', () => {
  const p = assumeMoreComing({ kind: 'private', text: '然后', maxWaitMs: 99999 });
  assert.ok(p.waitMs <= 12000);
});
