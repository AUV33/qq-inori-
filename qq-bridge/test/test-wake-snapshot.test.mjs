import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWakeSnapshot, formatSnapshotLine, renderWakeSnapshotV2 } from '../src/domain/conversation/wake-snapshot.mjs';

test('单条：seq、发送者、正文，没有句柄就不加分隔符', () => {
  assert.equal(formatSnapshotLine({ seq: 5, sender: '老张', text: '吃了吗' }), 'seq5 老张：吃了吗');
});

// [SNAPSHOT-CLOCK] 2026-10-30：她分不清"20 分钟前的旧问题"和"刚发的新问题"，
// 把旧的「这个是你画的？」当成新消息又答了一遍。快照行必须带时间。
test('带时间戳：今天显示 HH:MM，位置在 seq 与发送者之间', () => {
  const now = new Date();
  now.setHours(21, 22, 0, 0);
  const line = formatSnapshotLine({ seq: 7, sender: 'A', text: 'x', time: now.getTime() });
  assert.match(line, /^seq7 21:22 A：x$/);
});

test('正文换行压成空格：一条消息必须是一行', () => {
  assert.equal(formatSnapshotLine({ seq: 1, sender: 'A', text: '第一行\n第二行\t第三行' }), 'seq1 A：第一行 第二行 第三行');
});

test('句柄原样保留：引用 ID / 转发 / 媒体 / 类型', () => {
  const line = formatSnapshotLine({
    seq: 9, sender: 'B', text: '看这个', messageId: 'm123',
    forwardIds: ['f1', 'f2'], nestedForwardIds: ['n1'],
    media: [{ faceId: 14 }, { index: 2 }], kind: 'image',
  });
  assert.equal(line, 'seq9 B：看这个 ｜引用ID=m123 ｜转发=f1,f2 ｜转发的转发=n1 ｜媒体=表情14,图2 ｜类型=image');
});

test('缺失字段用占位符，不崩', () => {
  assert.equal(formatSnapshotLine({}), 'seq? ?：');
  assert.equal(formatSnapshotLine(null), 'seq? ?：');
});

test('主人标记：isOwner 时行首带【他】（prompt 里说"只有带【他】的才是他本人"）', () => {
  assert.equal(formatSnapshotLine({ seq: 5, sender: '老张', text: '在', isOwner: true }), 'seq5 【他】老张：在');
  assert.equal(formatSnapshotLine({ seq: 5, sender: '老张', text: '在', isOwner: false }), 'seq5 老张：在');
  const text = renderWakeSnapshotV2({
    messages: [{ seq: 1, sender: '我', text: 'a', isOwner: true }, { seq: 2, sender: '路人', text: 'b' }],
  });
  assert.equal(text, ['【未读】', 'seq1 【他】我：a', 'seq2 路人：b'].join('\n'));
});

test('带 QQ：有 userId 时行内含 QQ 号（供 qq_person 按人查印象）；没有就不加', () => {
  assert.equal(
    formatSnapshotLine({ seq: 24, sender: '群友丙', userId: '10003', text: '嗯？换回来了？' }),
    'seq24 群友丙（QQ 10003）：嗯？换回来了？',
  );
  assert.equal(formatSnapshotLine({ seq: 1, sender: 'A', text: 'x' }), 'seq1 A：x');
  assert.equal(
    formatSnapshotLine({ seq: 2, sender: 'AAA', userId: '10001', isOwner: true, text: '在吗' }),
    'seq2 【他】AAA（QQ 10001）：在吗',
  );
});

test('快照：trigger 单独一块，未读与旧话各带标题', () => {
  const text = renderWakeSnapshotV2({
    trigger: { seq: 3, sender: 'C', text: '在吗' },
    messages: [{ seq: 1, sender: 'A', text: 'a' }, { seq: 2, sender: 'B', text: 'b' }],
    recent: [{ seq: 0, sender: 'D', text: 'c' }],
  });
  assert.equal(text, [
    '【叫你的那条】seq3 C：在吗',
    '【未读】',
    'seq1 A：a',
    'seq2 B：b',
    '【之前聊的】',
    'seq0 D：c',
  ].join('\n'));
});

test('空包/空数组：不产生空标题', () => {
  assert.equal(renderWakeSnapshotV2({}), '');
  assert.equal(renderWakeSnapshotV2({ messages: [], recent: [] }), '');
  assert.equal(renderWakeSnapshotV2(null), '');
});

test('只有 trigger 时不出现【未读】/【之前聊的】', () => {
  assert.equal(renderWakeSnapshotV2({ trigger: { seq: 1, sender: 'A', text: 'x' } }), '【叫你的那条】seq1 A：x');
});

// ── buildWakeSnapshot（预算裁剪 / 触发器 / 空闲上下文）──────────────────────

const deps = (state, over = {}) => ({
  getState: () => state,
  context: {},
  toolEnabled: () => true,
  // 简化水位：已读位置就是 state 里记的数（真实实现更复杂，这里只验证"包怎么组装"）
  readThroughSeq: (st) => Number(st.lastReadThroughSeq) || 0,
  compactModelMessage: (m) => m,
  log: () => {},
  ...over,
});

const msg = (seq, text = 'hi') => ({ seq, text, sender: `u${seq}` });

test('buildWakeSnapshot：关闭或没有工具时返回 null', () => {
  const st = { unread: [msg(1)], recentMessages: [] };
  assert.equal(buildWakeSnapshot('group:1', deps(st, { context: { inlineWakeMessages: false } })), null);
  assert.equal(buildWakeSnapshot('group:1', deps(st, { toolEnabled: () => false })), null);
});

test('buildWakeSnapshot：预算内全部带上，omitted=0、partial=false', () => {
  const st = { unread: [msg(1), msg(2)], recentMessages: [] };
  const packet = buildWakeSnapshot('group:1', deps(st));
  assert.deepEqual(packet.messages.map((m) => m.seq), [1, 2]);
  assert.equal(packet.includedUnreadCount, 2);
  assert.equal(packet.omitted, 0);
  assert.equal(packet.partial, false);
});

test('buildWakeSnapshot：超预算时从旧到新装，超出的不带；最新未读作为 trigger 单独附上', () => {
  const long = 'x'.repeat(300);
  const st = { unread: [msg(1, long), msg(2, long), msg(3, long)], recentMessages: [] };
  // wakeMaxChars 最小 500：一条 300 字能装下，两条装不下
  const packet = buildWakeSnapshot('group:1', deps(st, { context: { wakeMaxChars: 500 } }));
  assert.equal(packet.messages.length, 1);
  assert.equal(packet.messages[0].seq, 1, '最旧的先装（不能替她确认没看到的）');
  assert.equal(packet.omitted, 2);
  assert.equal(packet.partial, true);
  assert.equal(packet.trigger?.seq, 3, '叫醒她的那条即使没装进未读也要单独附上');
});

test('buildWakeSnapshot：recent 过滤掉自己的话和未读重复，且只取最早未读之前的', () => {
  const st = {
    unread: [msg(5)],
    recentMessages: [msg(1), { ...msg(2), isSelf: true }, msg(3), msg(5)],
  };
  const packet = buildWakeSnapshot('group:1', deps(st));
  assert.deepEqual(packet.recent.map((m) => m.seq), [1, 3]);
});

test('buildWakeSnapshot：空闲唤醒（无未读）只带少量旧话并标 readContext', () => {
  const st = { unread: [], recentMessages: [msg(1), msg(2), msg(3), msg(4)] };
  const packet = buildWakeSnapshot('group:1', deps(st, { context: { wakeRecentLimit: 4, wakeRecentLimitWhenIdle: 2 } }));
  assert.equal(packet.readContext, true);
  assert.equal(packet.recent.length, 2, '空闲时按 wakeRecentLimitWhenIdle 收紧');
});

test('buildWakeSnapshot：把"这次看到哪"写回 state.pendingAckSeq', () => {
  const st = { unread: [msg(1)], recentMessages: [], lastReadThroughSeq: 0 };
  const packet = buildWakeSnapshot('group:1', deps(st));
  assert.equal(st.pendingAckSeq, packet.readThroughSeq);
});
