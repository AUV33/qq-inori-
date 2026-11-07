// 学习闭环 v2：任务真账 / 目标不假装完成 / 练习记录 / 会话笔记 / 实时反馈
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createItem, update as updateItem, render as renderItem } from '../src/domain/leaves/inori-learning-items.js';
import { start as startPractice, finish as finishPractice, update as updatePractice, load as loadPractice } from '../src/domain/leaves/inori-practice.js';
import { load as loadNotes, save as saveNotes, addCorrection, addOpenLoop, clearOpenLoops, renderBlock, prune } from '../src/domain/leaves/inori-session-notes.js';
import { looksLikeCorrection, classifyToolError, renderLiveHint } from '../src/domain/leaves/inori-live-feedback.js';
import { create as createDraft, setStatus, pending } from '../src/domain/leaves/inori-skill-drafts.js';
import { load as loadSkills, save as saveSkills, applyOutcome } from '../src/domain/leaves/inori-skills.js';

const tmp = (p) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-v2-')), p);

test('任务：成功必须有证据；没有证据降为 blocked', async () => {
  const file = tmp('task-ledger.jsonl');
  process.env.MZ_TASK_LEDGER = file;
  const T = await import('../src/domain/leaves/inori-taskledger.js?task-truth');
  const row = T.appendTask({ task: '把 JT8-3 打出三星', fingerprint: 'jt8-3' });
  const r1 = T.finishTask(row.id, { outcome: 'success', note: '打完了', evidence: '' });
  assert.equal(r1.row.outcome, 'blocked');
  assert.equal(r1.row.status, 'failed');
  assert.ok(r1.row.nextAction);

  const row2 = T.appendTask({ task: '把 JT8-3 打出三星', fingerprint: 'jt8-3' });
  const r2 = T.finishTask(row2.id, { outcome: 'success', evidence: 'data/pics/jt8.png 显示 3 星' });
  assert.equal(r2.row.outcome, 'success');
  assert.equal(r2.row.status, 'finished');
  assert.equal(r2.row.evidenceQuality, 'strong');
  const row3 = T.appendTask({ task: '随便做一下', fingerprint: 'weak-evidence' });
  const r3 = T.finishTask(row3.id, { outcome: 'success', evidence: '做完了' });
  assert.equal(r3.row.outcome, 'blocked');
  assert.equal(r3.row.evidenceQuality, 'weak');
});

test('任务：回合完成但没结果行 = unknown；待续带下一步', async () => {
  const file = tmp('task-ledger2.jsonl');
  process.env.MZ_TASK_LEDGER = file;
  const T = await import('../src/domain/leaves/inori-taskledger.js?task-unknown');
  const row = T.appendTask({ task: '打开明日方舟', fingerprint: 'open-ak' });
  const r = T.finishTask(row.id, { outcome: 'unknown', note: '进不去', nextAction: '先确认 adb 设备' });
  assert.equal(r.row.outcome, 'unknown');
  assert.equal(r.row.status, 'failed');
  const resumable = T.resumableTasks();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0].nextAction, '先确认 adb 设备');
  assert.ok(T.renderLedger().includes('上次没做完'));
});

test('任务：同指纹可找回并续跑，不新建', async () => {
  const file = tmp('task-ledger3.jsonl');
  process.env.MZ_TASK_LEDGER = file;
  const T = await import('../src/domain/leaves/inori-taskledger.js?task-resume');
  const row = T.appendTask({ task: '把基建收个尾', fingerprint: 'base-cleanup' });
  T.finishTask(row.id, { outcome: 'blocked', note: '贸易站没排完', nextAction: '先排贸易站' });
  const found = T.findResumableTask('base-cleanup');
  assert.ok(found && found.id === row.id);
  const resumed = T.resumeTask(found.id);
  assert.equal(resumed.status, 'queued');
  assert.equal(T.queuedCount(), 1);
});

test('任务：解析收尾结果行', async () => {
  const T = await import('../src/domain/leaves/inori-taskledger.js?parse');
  const p = T.parseTaskResult('干完了\n【任务结果】成功｜证据：截图 3 星｜下一步：继续下一关');
  assert.equal(p.outcome, 'success');
  assert.equal(p.evidence, '截图 3 星');
  assert.equal(p.nextAction, '继续下一关');
  assert.equal(T.parseTaskResult('没有结果行'), null);
});

test('目标：没证据的 done 降为 parked；有证据才 done', async () => {
  const G = await import('../src/domain/leaves/inori-goals.js?goal-truth');
  const goals = [{ id: 'g1', text: '把画画完', status: 'active', createdAt: '', touchedAt: '', progress: [] }];
  const r1 = G.update(goals, 'g1', { status: 'done' });
  assert.equal(r1.downgraded, true);
  assert.equal(goals[0].status, 'parked');
  const r2 = G.update(goals, 'g1', { status: 'done', evidence: '文件:data/pics/a.png' });
  assert.equal(r2.goal.status, 'done');
});

test('学习项：开始练必须有判据；同时只允许一件 practicing', () => {
  const items = [];
  const a = createItem(items, { title: '手画线条更稳', criterion: '5 条线两头不抖' });
  assert.equal(a.ok, true);
  const b = createItem(items, { title: '圆不扁', criterion: '首尾接上' });
  assert.equal(b.ok, true);
  const r1 = updateItem(items, a.item.id, { status: 'practicing' });
  assert.equal(r1.ok, true);
  const r2 = updateItem(items, b.item.id, { status: 'practicing' });
  assert.equal(r2.ok, true);
  assert.equal(items.find((x) => x.id === a.item.id).status, 'paused');
  assert.ok(renderItem(items).includes('圆不扁'));
  const c = createItem(items, { title: '没判据' });
  const r3 = updateItem(items, c.item.id, { status: 'practicing' });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'criterion-required');
  const doneNoEvidence = updateItem(items, a.item.id, { status: 'done' });
  assert.equal(doneNoEvidence.ok, false);
  assert.equal(doneNoEvidence.reason, 'evidence-required');
  const doneWithEvidence = updateItem(items, a.item.id, { status: 'done', evidence: '文件:data/pics/a.png' });
  assert.equal(doneWithEvidence.ok, true);
  assert.equal(doneWithEvidence.item.status, 'done');
});

test('练习：not_met 必须写一处问题+一处改动；met 可收尾', () => {
  const f = tmp('practice.jsonl');
  const s = startPractice({ itemId: 'li1', intention: '横线 5 条', criterion: '两头不抖' }, f);
  assert.equal(s.ok, true);
  const bad = finishPractice(s.session, { result: 'not_met' });
  assert.equal(bad.ok, false);
  const ok = finishPractice(s.session, { result: 'not_met', oneFlaw: '第3条断了', oneChange: '一口气画完' });
  assert.equal(ok.ok, true);
  assert.equal(ok.session.oneChange, '一口气画完');
  assert.equal(loadPractice(f).length, 1);
  const u = updatePractice(s.session.id, { result: 'met', evidence: '截图' }, f);
  assert.equal(u.ok, true);
  assert.equal(u.session.result, 'met');
});

test('会话笔记：纠正去重、渲染、过期清理', () => {
  const notes = {};
  addCorrection(notes, 'private:1', '不是这样，应该先看界面再点');
  addCorrection(notes, 'private:1', '不是这样，应该先看界面再点');
  assert.equal(notes['private:1'].corrections.length, 1);
  addOpenLoop(notes, 'private:1', '手机点了没反应', '先 phone_dump');
  const block = renderBlock(notes, 'private:1');
  assert.ok(block.includes('他刚纠正过'));
  assert.ok(block.includes('先 phone_dump'));
  const old = { 'private:1': { corrections: [{ at: '2000-01-01T00:00:00Z', text: 'x' }], openLoops: [], facts: [] } };
  assert.equal(prune(old), true);
  assert.equal(old['private:1'], undefined);
});

test('会话笔记：工具成功会清掉对应报错 openLoop', () => {
  const notes = {};
  addOpenLoop(notes, 'private:1', 'phone_tap 报错：点不到', '先 dump');
  addOpenLoop(notes, 'private:1', 'qq_send_message 报错：超时', '稍后重发');
  assert.equal(clearOpenLoops(notes, 'private:1', { prefix: 'phone_tap 报错：' }), true);
  assert.equal(notes['private:1'].openLoops.length, 1);
  assert.ok(notes['private:1'].openLoops[0].text.includes('qq_send_message'));
});

test('实时反馈：纠正识别 + 工具错误分类 + 三次停手', () => {
  assert.equal(looksLikeCorrection('不是这样，应该先看界面再点'), true);
  assert.equal(looksLikeCorrection('今天天气不错'), false);
  assert.equal(classifyToolError('phone_tap', '权限被拒绝').kind, 'permission');
  assert.equal(classifyToolError('phone_tap', '点不到，坐标没反应').kind, 'ui');
  assert.ok(renderLiveHint({ tool: 'phone_tap', error: '点不到', streak: 3 }).includes('停手'));
});

test('技能：turn 的 ok=true 只记 attempt；verify 才 success', () => {
  const f = tmp('skills.json');
  const store = { version: 1, items: [{ id: 's1', name: 'x', steps: ['a'], attempts: 0, success: 0, fail: 0, verify: '文件:x' }] };
  saveSkills(store, f);
  const st = loadSkills(f);
  applyOutcome(st, 's1', { ok: true, source: 'turn' });
  assert.equal(st.items[0].success, 0);
  assert.equal(st.items[0].attempts, 1);
  applyOutcome(st, 's1', { ok: true, source: 'turn', verifiedBy: 'verify', evidence: '文件:x' });
  assert.equal(st.items[0].success, 1);
  assert.equal(st.items[0].verifiedBy, 'verify');
});

test('技能草稿：创建、待定、拒掉', () => {
  const drafts = [];
  const r = createDraft(drafts, { name: '画横线', steps: ['一口气画完'], verify: '文件:x', learningItemId: 'li1' });
  assert.equal(r.ok, true);
  assert.equal(pending(drafts).length, 1);
  const s = setStatus(drafts, r.draft.id, 'rejected');
  assert.equal(s.ok, true);
  assert.equal(pending(drafts).length, 0);
});

test('练手位 v2：有 nextDrill 的旧技能进打磨位', async () => {
  const { pickPracticeSlots } = await import('../src/domain/social/practice-slot.mjs');
  const r = pickPracticeSlots([
    { name: '手画线条', injected: 10, success: 3, mastery: 0.3, nextDrill: '横线 5 条', verify: '文件:x' },
    { name: '普通旧技能', injected: 10, success: 3, mastery: 0.3 },
  ]);
  assert.deepEqual(r.polish.map((x) => x.name), ['手画线条']);
});
