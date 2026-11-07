// self-context-service 的金标：事实提炼/缓存、自我档案、自我叙事。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfContext } from '../src/domain/memory/self-context-service.mjs';

function ctx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-selfctx-'));
  const appended = [];
  const logs = [];
  const base = {
    cfg: { ownerQQ: 123 },
    log: (line) => logs.push(line),
    MEM_DIR: dir,
    STATE_DATA_DIR: dir,
    appendJsonl: (file, row) => { appended.push({ file, row }); return { ok: true }; },
    applyEmotionCalibration: (x) => x,
    appraiseSelfEmotion: () => ({}),
    buildEmpathicStance: () => '',
    buildQuoteContext: () => '',
    canonScope: (k) => k,
    classifyPragmaticFrame: () => ({}),
    createDiscourseState: () => ({}),
    dedupeFacts: (cands) => cands,
    describeEdit: (e) => `改了 ${e.file}`,
    extractFacts: () => [{ text: '他养猫', evidence: '私聊', kind: 'preference' }],
    filesForScope: () => ({ file: path.join(dir, 'memory.jsonl'), scope: 'private' }),
    findLanguageEpisodesByContext: () => [],
    getSocialV2State: () => ({ recentMessages: [] }),
    loadEntries: () => [],
    loadIntentions: () => [],
    loadMoodState: () => ({}),
    pickHerRecentEdit: () => null,
    readLanguageEpisodes: () => [],
    readOutcomes: () => [],
    renderDiscourseBlock: () => '',
    renderIntentionsBlock: () => '',
    renderLanguageEpisodeBlock: () => '',
    renderOutcomesBlock: () => '',
    renderPragmaticBlock: () => '',
    renderSelfEmotionBlock: () => '',
    renderSelfRecent: () => '',
    reverse: new Map(),
    saveSocialV2State: () => {},
    stateDataPath: (p) => path.join(dir, p),
    stateWithKey: () => ({}),
    updateDiscourseState: () => {},
    writeTextAtomic: (file, text) => { fs.writeFileSync(file, text); },
  };
  Object.assign(base, overrides);
  return { svc: createSelfContext(base), dir, appended, logs };
}

test('readMemoryRows：坏行跳过，读不到返回空', () => {
  const h = ctx();
  fs.writeFileSync(path.join(h.dir, 'memory.jsonl'), '{"a":1}\nnot-json\n{"b":2}\n');
  assert.deepEqual(h.svc.readMemoryRows().map((r) => Object.keys(r)[0]), ['a', 'b']);
  fs.unlinkSync(path.join(h.dir, 'memory.jsonl'));
  assert.deepEqual(h.svc.readMemoryRows(), []);
});

test('maybeExtractFacts：只提炼 owner 私聊，写 fact 并清缓存', () => {
  const h = ctx();
  h.svc.maybeExtractFacts('group:1', { text: '他养猫' });
  assert.equal(h.appended.length, 0);
  h.svc.maybeExtractFacts('private:123', { text: '他养猫' });
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].row.kind, 'fact');
  assert.equal(h.appended[0].row.text, '他养猫');
  assert.match(h.logs[0], /\+1 条/);
});

test('renderCoreFacts：渲染最近 fact，按 mtime 缓存', () => {
  const h = ctx();
  const file = path.join(h.dir, 'memory.jsonl');
  fs.writeFileSync(file, '{"kind":"fact","text":"他养猫"}\n{"kind":"event","text":"x"}\n');
  const out = h.svc.renderCoreFacts();
  assert.match(out, /关于他/);
  assert.match(out, /他养猫/);
  assert.equal(h.svc.renderCoreFacts(), out); // 缓存命中
});

test('renderSelfProfile：技能/经验/她自己的改动/目标/待改', () => {
  const h = ctx({ pickHerRecentEdit: () => ({ file: 'src/app.mjs' }) });
  fs.writeFileSync(path.join(h.dir, 'skills.json'), JSON.stringify({ skills: [{ name: '查天气' }] }));
  fs.writeFileSync(path.join(h.dir, 'goals.json'), JSON.stringify({ goals: [{ text: 'a' }, { text: 'b', done: true }] }));
  fs.writeFileSync(path.join(h.dir, 'evolution.jsonl'), '{}\n');
  const out = h.svc.renderSelfProfile({ lessonCount: 7, chase: { count: 2, rate: 20 }, work: { failed: 1 } });
  assert.match(out, /查天气/);
  assert.match(out, /7 条经验/);
  assert.match(out, /我最近改过自己/);
  assert.match(out, /1 件事要做/);
  assert.match(out, /追人回报 20%/);
  assert.match(out, /做事失败 1 次/);
});

test('自我叙事：保存/读取/渲染，超长截到 4000', () => {
  const h = ctx();
  assert.equal(h.svc.renderSelfNarrative(), '');
  const saved = h.svc.saveSelfNarrative('x'.repeat(5000));
  assert.equal(saved.text.length, 4000);
  assert.match(h.svc.loadSelfNarrative().text, /^x+$/);
  assert.match(h.svc.renderSelfNarrative(), /你现在怎么看自己/);
  h.svc.saveSelfNarrative('hello');
  const backups = fs.readdirSync(h.dir).filter((f) => f.includes('self-notes.md.bak-'));
  assert.ok(backups.length >= 1);
});
