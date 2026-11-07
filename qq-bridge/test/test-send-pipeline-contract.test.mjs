// 发送流水线端到端契约：入口 sendToQQ → outgoing-queue → bot 传输 → 记账 / 未送达 / 可见性。
//
// 补的是闭环盘点里点名的缺口（docs/internal/_archive/规划/闭环与咬合-20261103.md §4「仍在」第 1 条）：
// 「发送失败后回滚 + 记账 + 用户可见」的组合此前只有分散单测，没有一条从入口走到底的契约。
// 这里全部用假的 bot + 真的队列 + 真的账本，不碰网络与真实 state。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-pipeline-'));
process.env.SEND_LEDGER_FILE = path.join(dir, 'ledger.json');

const ledger = await import('../src/domain/send/send-ledger.js');
const { fingerprint } = ledger;
const { createSendService } = await import('../src/domain/send/send-service.mjs');
const { createOutgoingQueue } = await import('../src/domain/send/outgoing-queue.mjs');
const { reserveSendTimes, rollbackSendTimes, checkSendRate } = await import('../src/domain/send/send-service.js');

function resetLedger() {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
}

function ledgerItems() {
  try {
    return JSON.parse(fs.readFileSync(process.env.SEND_LEDGER_FILE, 'utf8')).items || [];
  } catch { return []; }
}

function makeBot({ failPrivate = false, failGroup = false, mutedUntil = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async getLoginInfo() { return { user_id: 10002 }; },
    async getGroupMemberInfo() { return { shut_up_timestamp: mutedUntil }; },
    async sendPrivateMessage(id, msg) {
      if (failPrivate) throw new Error('network down');
      calls.push(['private', id, msg]);
      return { message_id: 1 };
    },
    async sendGroupMessage(id, msg) {
      if (failGroup) throw new Error('group down');
      calls.push(['group', id, msg]);
      return { message_id: 2 };
    },
  };
}

function makeSvc({ bot, split = (s) => [s], guard = () => () => {} } = {}) {
  const outgoing = createOutgoingQueue();
  const acked = [];
  const undelivered = [];
  const log = [];
  const inputStatus = [];
  const sts = new Map();
  const ctx = {
    cfg: { socialV2: { send: { maxMessageChars: 500, quoteFix: true } }, sendDelayMs: 0 },
    log: (...args) => log.push(args.join(' ')),
    knownAgentTokens: new Set(),
    captureSendGuard: guard,
    stripSelfQuoting: (s) => s,
    sendLedger: ledger,
    splitForQQ: split,
    getOutgoing: () => outgoing,
    withTimeout: async (p) => p,
    getBot: () => bot,
    escapeCqText: (s) => s,
    text: (s) => s,
    appendUndelivered: (entry) => undelivered.push(entry),
    undeliveredFile: path.join(dir, 'undelivered.jsonl'),
    sleep: async () => {},
    getSocialV2State: (key) => {
      if (!sts.has(key)) sts.set(key, {});
      return sts.get(key);
    },
    getAutoAckAfterSend: () => (key) => acked.push(key),
    relevanceCos: async () => null,
    getSetInputStatus: () => (id, on) => inputStatus.push([id, on]),
    randInt: (min) => min,
    SEND_TIMEOUT_MS: 1000,
  };
  return { svc: createSendService(ctx), outgoing, acked, undelivered, log, inputStatus };
}

test('成功发送：记「auto 已发」账、succeeded=true、autoAck 一次、无未送达', async () => {
  resetLedger();
  const bot = makeBot();
  const { svc, outgoing, acked, undelivered } = makeSvc({ bot });
  await svc.sendToQQ('private:10001', '你好呀');

  assert.equal(bot.calls.length, 1, '应该真的调用了 sendPrivateMessage');
  assert.equal(outgoing.succeeded('private:10001'), true);
  assert.deepEqual(acked, ['private:10001'], '成功后要 ack 一次');
  assert.equal(undelivered.length, 0);
  const hit = ledgerItems().find((e) => e.k === 'private:10001'
    && e.h === fingerprint('private:10001', '你好呀') && e.p === 'auto');
  assert.ok(hit, '发出去之后必须落一条 auto 账');
});

test('工具已经发过同一句：自动转发让路，不重复说（10 分钟窗口）', async () => {
  resetLedger();
  ledger.note('private:10001', '我去看看', 'tool', Date.now() - 1000);
  const bot = makeBot();
  const { svc, log } = makeSvc({ bot });
  await svc.sendToQQ('private:10001', '我去看看');

  assert.equal(bot.calls.length, 0, '工具刚发过，自动转发不应再调传输');
  assert.ok(log.some((l) => l.includes('[dedupe]')), '跳过要留痕');
});

test('发送失败：标记失败 + 记未送达 + 留日志 + 不落已发账 + 不 autoAck', async () => {
  resetLedger();
  const bot = makeBot({ failPrivate: true });
  const { svc, outgoing, acked, undelivered, log } = makeSvc({ bot });
  await svc.sendToQQ('private:10001', '在吗');

  assert.equal(outgoing.succeeded('private:10001'), false, '调用方必须能看出这轮没发出去');
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].key, 'private:10001');
  assert.equal(undelivered[0].text, '在吗');
  assert.ok(log.some((l) => l.includes('QQ 发送失败 (private:10001)')), '失败不能只吞成静默');
  assert.equal(acked.length, 0, '没发出去就不该宣布「已开口」');
  const bad = ledgerItems().find((e) => e.k === 'private:10001'
    && e.h === fingerprint('private:10001', '在吗') && e.p === 'auto');
  assert.equal(bad, undefined, '失败绝不能留下「已发」记录');
});

test('失败之后下一次成功：succeeded 恢复，autoAck 只在成功那次发生', async () => {
  resetLedger();
  let fail = true;
  const bot = {
    calls: [],
    async getLoginInfo() { return { user_id: 1 }; },
    async getGroupMemberInfo() { return { shut_up_timestamp: 0 }; },
    async sendPrivateMessage(id, msg) {
      if (fail) throw new Error('network down');
      this.calls.push(['private', id, msg]);
      return { message_id: 1 };
    },
  };
  const { svc, outgoing, acked } = makeSvc({ bot });

  await svc.sendToQQ('private:10001', '第一次');
  assert.equal(outgoing.succeeded('private:10001'), false);

  fail = false;
  await svc.sendToQQ('private:10001', '第二次');
  assert.equal(outgoing.succeeded('private:10001'), true, '下一批成功要清掉失败标记');
  assert.deepEqual(acked, ['private:10001']);
});

test('发送闸门抛错：同样走失败记账，不静默丢掉', async () => {
  resetLedger();
  const bot = makeBot();
  const guard = () => () => { throw new Error('blocked by policy'); };
  const { svc, outgoing, undelivered } = makeSvc({ bot, guard });
  await svc.sendToQQ('private:10001', '这句话被闸门拦了');

  assert.equal(bot.calls.length, 0);
  assert.equal(outgoing.succeeded('private:10001'), false);
  assert.equal(undelivered.length, 1, '被拦下的话也要进未送达，不能凭空消失');
});

test('多段里只失败一段：成功的段落账、失败的段不记账，整批仍算失败', async () => {
  resetLedger();
  let n = 0;
  const bot = {
    calls: [],
    async getLoginInfo() { return { user_id: 1 }; },
    async getGroupMemberInfo() { return { shut_up_timestamp: 0 }; },
    async sendPrivateMessage(id, msg) {
      n += 1;
      if (n === 2) throw new Error('第二段断了');
      this.calls.push(['private', id, msg]);
      return { message_id: n };
    },
  };
  const { svc, outgoing, undelivered } = makeSvc({ bot, split: (s) => s.split('|') });
  await svc.sendToQQ('private:10001', '第一段|第二段');

  assert.equal(bot.calls.length, 1);
  const ok = ledgerItems().find((e) => e.h === fingerprint('private:10001', '第一段') && e.p === 'auto');
  const bad = ledgerItems().find((e) => e.h === fingerprint('private:10001', '第二段') && e.p === 'auto');
  assert.ok(ok, '成功的段要记账，重启后才不会重复');
  assert.equal(bad, undefined, '失败的段不能记账');
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].text, '第二段');
  assert.equal(outgoing.succeeded('private:10001'), false);
});

test('群发被禁言：不投递、标记失败、只记一次日志（不反复撞 result=120）', async () => {
  resetLedger();
  const bot = makeBot({ mutedUntil: Math.floor(Date.now() / 1000) + 600 });
  const { svc, outgoing, log } = makeSvc({ bot });
  await svc.sendToQQ('group:20002', '大家好呀');

  assert.equal(bot.calls.length, 0, '禁言期间不应调用 sendGroupMessage');
  assert.equal(outgoing.succeeded('group:20002'), false);
  assert.ok(log.some((l) => l.includes('[mute]')), '跳过要留痕');
});

test('可见性边界：系统报错提示不投递到群，私聊照发', async () => {
  resetLedger();
  const bot = makeBot();
  const { svc, log } = makeSvc({ bot });
  await svc.sendNotice('group:20002', 'agent 出错了');
  assert.equal(bot.calls.length, 0, '群里只该看到她真正想说的话');
  assert.ok(log.some((l) => l.includes('[notice-suppressed]')));

  await svc.sendNotice('private:10001', 'agent 出错了');
  assert.deepEqual(bot.calls, [['private', 10001, 'agent 出错了']]);
});

test('额度回滚：预占 2 条只承诺发出 1 条时，回滚未发出的部分', () => {
  const st = { sendTimes: [] };
  const now = 1_800_000_000_000;
  reserveSendTimes(st, now, 2);
  assert.equal(st.sendTimes.length, 2);
  // 已占 2 条，再发 1 条会到 3 > 上限 2 —— 必须拒绝
  assert.equal(checkSendRate(st, now, { maxPerMinute: 2 }).ok, false);
  rollbackSendTimes(st, now, 1);
  assert.equal(st.sendTimes.length, 1);
  assert.equal(checkSendRate(st, now, { maxPerMinute: 2 }).ok, true, '回滚后应重新可用');
});

test('队列语义：一个任务失败不阻断后面的任务，且不产生 unhandledRejection', async () => {
  const errors = [];
  const q = createOutgoingQueue({ onError: (error) => errors.push(error) });
  const order = [];
  q.enqueue(async () => { order.push('first'); throw new Error('boom'); });
  q.enqueue(async () => { order.push('second'); });
  await q.whenIdle();
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(errors.length, 1);
  assert.deepEqual(q.stats(), { pending: 0, failed: 0 });
});
