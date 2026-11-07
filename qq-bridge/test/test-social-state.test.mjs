// social-state 金标：状态读写与规范化——防永眠、防覆盖他人写入、防字段白名单丢数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialState } from '../src/domain/social/social-state.mjs';

const NOW = Date.now();
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sstate-')), 'social-v2.json');

function makeCtx(overrides = {}) {
  const file = overrides.file ?? tmpFile();
  const out = { logs: [], writes: [], tokens: [], proactive: [], sleep: [] };
  const socialV2 = overrides.socialV2 ?? { paused: false, conversations: new Map() };
  const seenForwardIds = overrides.seenForwardIds ?? new Map();
  const svc = createSocialState({
    socialV2,
    seenForwardIds,
    socialFile: file,
    log: (...args) => out.logs.push(args.map(String).join(' ')),
    readJsonSafe: (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } },
    atomicWriteJson: (f, obj) => { out.writes.push(obj); fs.writeFileSync(f, JSON.stringify(obj)); },
    defaultWakeConfigV2: () => ({ mode: 'diving', infinite: true, sleepUntil: null, confirmedBy: 'default', triggers: { anyMessage: false, atMention: true, nameMention: true, speakerIds: [], keywords: [], poke: true, question: false, probability: 0 } }),
    refreshDefaultWakeConfigV2: (st) => { if (st?.wakeConfig?.confirmedBy === 'default') st.wakeConfig = { ...st.wakeConfig, refreshed: true }; },
    normalizeSpeakerIdsV2: (v) => (Array.isArray(v) ? v.map(String).filter((s) => /^[1-9]\d*$/.test(s)) : []),
    canonicalV2Key: (key) => {
      const m = /^(group|private):0*(\d+)$/.exec(String(key ?? ''));
      return m ? `${m[1]}:${m[2]}` : null;
    },
    rememberAgentToken: (key, token) => out.tokens.push({ key, token }),
    sanitizeForwardId: (v) => (/^[\w:.\-/=+@]+$/.test(String(v ?? '')) ? String(v) : ''),
    scheduleProactiveCheckV2: (key) => out.proactive.push(key),
    setupSleepTimerV2: (key) => out.sleep.push(key),
    takeExpiredHint: (hint, now) => (hint && now - Number(hint.at) > 600000 ? { text: hint.text, at: hint.at } : null),
    sinkUnsentHint: (text, at, key) => { out.sunk = out.sunk ?? []; out.sunk.push({ text, at, key }); },
    ...overrides.ctxExtra,
  });
  return { svc, out, file, socialV2, seenForwardIds };
}

test('computeWakeSafetyV2：硬触发/定时/概率算 guaranteed，confirmedAt 超 24h 算 stale', () => {
  const h = makeCtx();
  const hard = h.svc.computeWakeSafetyV2({ mode: 'active', triggers: {} });
  assert.equal(hard.hard, true);
  assert.equal(hard.guaranteed, true);

  const kw = h.svc.computeWakeSafetyV2({ triggers: { keywords: ['方舟'] } });
  assert.equal(kw.hard, true);

  const soft = h.svc.computeWakeSafetyV2({ triggers: { probability: 0.3 } });
  assert.equal(soft.hard, false);
  assert.equal(soft.soft, true);
  assert.equal(soft.guaranteed, true);

  const timed = h.svc.computeWakeSafetyV2({ infinite: false, sleepUntil: new Date(NOW + 60000).toISOString(), triggers: {} });
  assert.equal(timed.timed, true);

  assert.equal(h.svc.computeWakeSafetyV2({ triggers: {}, confirmedAt: NOW }).stale, false);
  assert.equal(h.svc.computeWakeSafetyV2({ triggers: {}, confirmedAt: NOW - 25 * 3600 * 1000 }).stale, true);
  assert.equal(h.svc.computeWakeSafetyV2({ triggers: {} }).stale, true);
});

test('ensureWakeableV2：一个触发条件都没有时重置默认配置并落盘（防永眠）', () => {
  const h = makeCtx();
  const st = { key: 'group:1', wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, poke: false, question: false, anyMessage: false, keywords: [], speakerIds: [], probability: 0 } } };
  h.svc.ensureWakeableV2(st);
  assert.equal(st.wakeConfig.confirmedBy, 'default');
  assert.equal(h.out.writes.length, 1);
  assert.deepEqual(h.out.sleep, ['group:1']);
  assert.ok(h.out.logs.some((l) => l.includes('避免永眠')));
});

test('ensureWakeableV2：有触发条件就保留；skipSave 时不落盘', () => {
  const h = makeCtx();
  const st = { wakeConfig: { triggers: { atMention: true, keywords: [], speakerIds: [] } } };
  h.svc.ensureWakeableV2(st);
  assert.equal(h.out.writes.length, 0);

  const dead = { wakeConfig: { triggers: { atMention: false, anyMessage: false, keywords: [], speakerIds: [] } } };
  const h2 = makeCtx();
  h2.svc.ensureWakeableV2(dead, { skipSave: true });
  assert.equal(h2.out.writes.length, 0, 'skipSave 用于加载阶段，避免覆盖未加载会话');
  assert.equal(dead.wakeConfig.confirmedBy, 'default');
});

test('ensureWakeableV2：定时睡眠未到期也算可唤醒；speakerIds 会被归一化', () => {
  const h = makeCtx();
  const st = { wakeConfig: { infinite: false, sleepUntil: new Date(NOW + 60000).toISOString(), triggers: { atMention: false, nameMention: false, poke: false, keywords: [], speakerIds: ['0', '123'] } } };
  h.svc.ensureWakeableV2(st);
  assert.equal(h.out.writes.length, 0, '有定时唤醒就不重置');
  assert.deepEqual(st.wakeConfig.triggers.speakerIds, ['123']);
});

test('getSocialV2State：非法 key 抛 400；合法 key 规范化并建默认状态', () => {
  const h = makeCtx();
  assert.throws(() => h.svc.getSocialV2State('bogus'), (e) => e.statusCode === 400);
  const st = h.svc.getSocialV2State('group:007');
  assert.ok(h.socialV2.conversations.has('group:7'), '前导零被规范化');
  assert.match(st.agentToken, /^[0-9a-f]{32}$/);
  assert.equal(st.bootstrapSent, false);
  assert.ok(st.modelSeenSeqs instanceof Set);
  assert.deepEqual(h.out.proactive, ['group:7']);
  assert.deepEqual(h.out.sleep, ['group:7']);
  assert.equal(h.svc.getSocialV2State('group:7'), st, '同一 key 复用同一对象');
});

test('loadSocialV2State：合并唤醒默认值、丢弃非法 key、修正 isSelf+isOwner 的历史脏标记', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    paused: true,
    conversations: {
      'group:1': {
        wakeConfig: { confirmedBy: 'owner', triggers: { keywords: ['方舟'] } },
        recentMessages: [{ text: '我说的', isSelf: true, isOwner: true }],
        unread: [{ text: '她说的', isSelf: true, isOwner: true }],
      },
      'group:2': { wakeConfig: { confirmedBy: 'default', triggers: {} } },
      'bad-key': { wakeConfig: {} },
    },
  }), 'utf8');
  const h = makeCtx({ file });
  h.svc.loadSocialV2State();
  assert.equal(h.socialV2.paused, true);
  assert.equal(h.socialV2.conversations.size, 2, '非法 key 被丢弃，合法会话保留');
  assert.equal(h.socialV2.conversations.has('bad-key'), false, '非法 key 不建状态');
  const st = h.socialV2.conversations.get('group:1');
  assert.equal(st.recentMessages[0].isOwner, false, '她自己发的不再是 owner');
  assert.equal(st.unread[0].isOwner, false);
  assert.deepEqual(st.wakeConfig.triggers.keywords, ['方舟']);
  assert.equal(st.wakeConfig.triggers.atMention, true, '缺省 triggers 由默认配置补齐');
  assert.equal(st.wakeConfig.confirmedBy, 'owner');
  assert.ok(!st.wakeConfig.refreshed, '显式设置过的会话不被默认值刷新');
  assert.ok(h.socialV2.conversations.get('group:2').wakeConfig.refreshed, 'confirmedBy=default 的会话会被刷新');
});

test('loadSocialV2State：未知字段直通（save/load 白名单不同步会丢数据）', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ conversations: { 'group:1': { groupFeedback: { sent: 3, replied: 2 }, customField: 'keep-me' } } }), 'utf8');
  const h = makeCtx({ file });
  h.svc.loadSocialV2State();
  const st = h.socialV2.conversations.get('group:1');
  assert.deepEqual(st.groupFeedback, { sent: 3, replied: 2 });
  assert.equal(st.customField, 'keep-me');
});

test('loadSocialV2State：agentToken 去重；memberImpressions 去掉原型污染键；私聊 speakerIds 清空', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    conversations: {
      'group:1': { agentToken: 'same-token', wakeConfig: { triggers: { speakerIds: ['1'] } } },
      'group:2': { agentToken: 'same-token', wakeConfig: { triggers: { speakerIds: ['2'] } } },
      'private:3': { memberImpressions: { __proto__: { x: 1 }, constructor: {}, 小明: { traits: ['话多'] } }, wakeConfig: { triggers: { speakerIds: ['9'] } } },
    },
  }), 'utf8');
  const h = makeCtx({ file });
  h.svc.loadSocialV2State();
  const a = h.socialV2.conversations.get('group:1');
  const b = h.socialV2.conversations.get('group:2');
  assert.notEqual(a.agentToken, b.agentToken, '重复 token 必须重新生成');
  const priv = h.socialV2.conversations.get('private:3');
  assert.equal(priv.memberImpressions.__proto__ && Object.prototype.hasOwnProperty.call(priv.memberImpressions, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(priv.memberImpressions, 'constructor'), false);
  assert.deepEqual(priv.memberImpressions.小明.traits, ['话多']);
  assert.deepEqual(priv.wakeConfig.triggers.speakerIds, [], '私聊不认指定发言人');
});

test('loadSocialV2State：从消息与已存字段重建 seenForwardIds（消息出窗后仍能去重）', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    conversations: {
      'group:1': { seenForwardIds: ['saved1'], recentMessages: [{ forwardIds: ['m1', 'bad id'] }] },
    },
  }), 'utf8');
  const h = makeCtx({ file });
  h.svc.loadSocialV2State();
  assert.deepEqual([...h.seenForwardIds.get('group:1')].sort(), ['m1', 'saved1']);
});

test('loadSocialV2State：首次加载从单文件迁移到分片目录并保留备份', () => {
  const file = tmpFile();
  const original = { conversations: { 'group:1': { wakeConfig: {} } } };
  fs.writeFileSync(file, JSON.stringify(original), 'utf8');
  const h = makeCtx({ file });
  h.svc.loadSocialV2State();
  // M1：单文件已拆成分片，每会话独立文件；旧文件改名备份而非被覆盖。
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'social-v2.shards', 'group_1.json')), '分片已生成');
  assert.ok(fs.existsSync(file + '.migrated'), '旧单文件改名备份，未被回写覆盖');
  assert.equal(h.socialV2.conversations.size, 1, '会话从分片还原');
  assert.ok(h.socialV2.conversations.has('group:1'));
});

test('saveSocialV2State：剔除瞬态定时器、按上限裁剪数组、带上 seenForwardIds', () => {
  const h = makeCtx();
  const st = {
    wakeConfig: {},
    pendingWakeTimer: { fake: true }, sleepTimer: 1, replyCheckTimer: 2, proactiveTimer: 3,
    recentMessages: Array.from({ length: 250 }, (_, i) => ({ i })),
    unread: Array.from({ length: 150 }, (_, i) => ({ i })),
    wakeTimes: Array.from({ length: 250 }, (_, i) => i),
    sendTimes: Array.from({ length: 600 }, (_, i) => i),
    activeTopics: Array.from({ length: 60 }, (_, i) => i),
    pendingThoughts: Array.from({ length: 60 }, (_, i) => i),
    keepMe: 'yes',
  };
  h.socialV2.conversations.set('group:1', st);
  h.seenForwardIds.set('group:1', new Set(Array.from({ length: 1200 }, (_, i) => `f${i}`)));
  h.svc.saveSocialV2State();
  // M2：关系态写主分片、任务态写独立 task 分片；两者都带 key。主分片按「含 recentMessages」识别。
  const saved = h.out.writes.find((w) => w && w.key === 'group:1' && Array.isArray(w.recentMessages));
  assert.ok(saved, 'group:1 主分片（关系态）已写入');
  for (const k of ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer']) assert.equal(saved[k], undefined, `${k} 不该落盘`);
  assert.equal(saved.recentMessages.length, 200);
  assert.equal(saved.unread.length, 100);
  assert.equal(saved.activeTopics.length, 50, 'activeTopics 是关系态，留在主分片');
  assert.equal(saved.pendingThoughts.length, 50, 'pendingThoughts 是关系态，留在主分片');
  assert.equal(saved.seenForwardIds.length, 1000);
  assert.equal(saved.keepMe, 'yes', '未知字段也要落盘');
  assert.equal(saved.wakeTimes, undefined, 'wakeTimes 已拆到 task 分片，不该在主分片');
  // 任务态独立落盘到 task 分片
  const task = h.out.writes.find((w) => w && w.key === 'group:1' && Array.isArray(w.wakeTimes));
  assert.ok(task, 'group:1 task 分片（任务态）已写入');
  assert.equal(task.wakeTimes.length, 200);
  assert.equal(task.sendTimes.length, 500);
  assert.equal(task.activeTopics, undefined, 'activeTopics 不在 task 分片');
  assert.equal(st.pendingWakeTimer.fake, true, '不能改动内存态');
});

test('drainUnsentHints：过期挂心事沉底并清空；没有过期的不落盘', () => {
  const h = makeCtx();
  h.socialV2.conversations.set('group:1', { noSendHint: { text: '没发出去的', at: NOW - 700000 } });
  h.socialV2.conversations.set('group:2', { noSendHint: { text: '新鲜的', at: NOW - 1000 } });
  h.svc.drainUnsentHints();
  assert.equal(h.out.sunk.length, 1);
  assert.equal(h.out.sunk[0].text, '没发出去的');
  assert.equal(h.socialV2.conversations.get('group:1').noSendHint, null);
  assert.ok(h.socialV2.conversations.get('group:2').noSendHint, '没过期的不动');
  // M1：drain 触发 save，save 写 _meta + 各会话分片，写入次数 >= 2 而非固定 1。
  assert.ok(h.out.writes.length >= 2, '分片落盘：_meta 与各会话分片均已写入');

  const clean = makeCtx();
  clean.socialV2.conversations.set('group:1', {});
  clean.svc.drainUnsentHints();
  assert.equal(clean.out.writes.length, 0);
});
