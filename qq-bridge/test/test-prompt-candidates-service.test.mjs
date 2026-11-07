// prompt-candidates-service 金标：知识候选与技能候选两条线，只递一行、不越权写库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptCandidates } from '../src/domain/memory/prompt-candidates-service.mjs';

function makeCtx(overrides = {}) {
  const state = { saves: 0, log: [], convState: {} };
  const ctx = {
    cfg: { socialV2: { skills: { file: 'skills.json' } } },
    log: (m) => state.log.push(String(m)),
    TOOL_LOG_FILE: 'tool-log.jsonl',
    readJsonlSafe: () => [{ tool: 'dictionary_lookup', q: '蒟蒻' }],
    collectLookups: (rows) => rows.map((r) => ({ term: r.q })),
    cognition: { load: () => ({ items: [{ term: '蒟蒻', meaning: '魔芋' }] }) },
    pickCandidates: (lookups, items) => lookups.map((l) => ({ ...l, ...(items.items.find((i) => i.term === l.term) ?? {}) })),
    renderCandidates: (list) => (list.length ? `【知识候选】${list.map((c) => c.term).join('、')}` : ''),
    getSocialV2State: (key) => (state.convState[key] ??= {}),
    saveSocialV2State: () => { state.saves += 1; },
    loadSkills: () => ({ items: [] }),
    detectSkillCandidates: () => [{ goal: '整理群记忆' }],
    recentTraces: () => [],
    renderSkillCandidates: (list) => `【技能候选】${list.map((c) => c.goal).join('、')}`,
    ...overrides,
  };
  return { svc: createPromptCandidates(ctx), state };
}

test('知识候选：有查词记录就拼一行', () => {
  const h = makeCtx();
  assert.equal(h.svc.renderKnowledgeCandidates(), '【知识候选】蒟蒻');
});

test('知识候选：没有记录 / 抛错都返回空串（不打断提示词拼装）', () => {
  assert.equal(makeCtx({ readJsonlSafe: () => [] }).svc.renderKnowledgeCandidates(), '');
  assert.equal(makeCtx({ collectLookups: () => [] }).svc.renderKnowledgeCandidates(), '');
  assert.equal(makeCtx({ cognition: { load: () => { throw new Error('坏了'); } } }).svc.renderKnowledgeCandidates(), '');
});

test('技能候选：只出现在私聊，群聊返回空串', () => {
  const h = makeCtx();
  assert.equal(h.svc.renderSkillCandidateLine('group:123'), '');
  assert.equal(h.svc.renderSkillCandidateLine('private:1'), '【技能候选】整理群记忆');
});

test('技能候选：24 小时内不重复提醒，超出后再次提醒', () => {
  const h = makeCtx();
  assert.ok(h.svc.renderSkillCandidateLine('private:1').length > 0);
  const firstAt = h.state.convState['private:1'].lastSkillCandidateAt;
  assert.ok(firstAt > 0);
  assert.equal(h.svc.renderSkillCandidateLine('private:1'), '', '24h 内不再提醒');
  h.state.convState['private:1'].lastSkillCandidateAt = Date.now() - 25 * 3600 * 1000;
  assert.ok(h.svc.renderSkillCandidateLine('private:1').length > 0);
});

test('技能候选：没有候选就不写状态、不落盘', () => {
  const h = makeCtx({ detectSkillCandidates: () => [] });
  assert.equal(h.svc.renderSkillCandidateLine('private:1'), '');
  assert.equal(h.state.saves, 0);
  assert.equal(h.state.convState['private:1'].lastSkillCandidateAt, undefined);
});
