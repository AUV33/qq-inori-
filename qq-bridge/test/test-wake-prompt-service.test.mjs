// wake-prompt-service 的金标：静默说明、实时学习块、提醒 prompt 的分层裁剪。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWakePromptService } from '../src/domain/conversation/wake-prompt-service.mjs';

function ctx(overrides = {}) {
  const calls = { added: 0, saved: 0, pruned: 0 };
  const base = {
    MEM_DIR: '/mem', STATE_DIR: '/state', cfg: { ownerQQ: 123, socialV2: { wake: { preSleepWaitMs: 300000 } } },
    buildStickerContext: () => '', buildStickerStrategyHint: () => '', controlRoomLineFor: () => '',
    dialogStructureBlock: () => '', drainUnsentHints: () => {}, evaluateSpeakGate: () => ({}),
    filesForScope: () => ({ file: '/mem/x.jsonl', scope: 'private' }), formatMemoryV2: () => '',
    formatParticipationV2: () => '', fs, getSocialV2State: () => ({ agentToken: 'tok', recentMessages: [] }),
    imageHintLine: () => '', isSessionAllowedInCurrentMode: () => true, getLifeState: () => ({ state: 'awake' }),
    loadWishState: () => ({}), log: () => {}, looksLikeUnfinished: () => false, path,
    pickStickerByQuery: () => null, readRoleState: () => ({ role: '测试角色' }),
    renderConversations: () => '', renderCuriosityLine: () => '', renderLifeLine: () => '',
    humanizeGap: () => '', renderPersonaCue: () => '', renderRecentLines: () => '',
    renderRelationship: () => '', renderUnsentLine: () => null, renderVoiceVarietyHint: () => '',
    renderWishLine: () => '', replyTimingV2: () => 0, requireMemoryEntries: () => [],
    roleHintForMode: () => 'role-card-full', saveSocialV2State: () => {}, selfNickname: '祈',
    silentGuardLine: () => '', socialV2: {}, stickerEmptyBoxHint: () => '',
    getStickerEntries: () => [], stickerPoolLine: () => '', stickerShortRefOf: () => '',
    summarizeRelationship: () => ({}), wakeEncounterLine: () => '', wakeFailureLine: () => '',
    wakeGlossLine: () => '', loadSessionNotes: () => ({ notes: [] }),
    looksLikeCorrection: () => true,
    addCorrection: () => { calls.added += 1; return { ok: true, duplicate: false }; },
    pruneSessionNotes: () => { calls.pruned += 1; return false; },
    saveSessionNotes: () => { calls.saved += 1; },
    renderSessionNotesBlock: () => 'notes-block',
    shouldInjectLearningItem: () => true, loadLearningItems: () => [{ id: 'l1' }],
    recentPractice: () => [], renderLearningItems: () => 'items-block',
    loadSkillDrafts: () => [], renderSkillDrafts: () => '', stateDataPath: (x) => `/state/${x}`,
    renderWeeklyReview: () => '', renderDayPlanBlock: () => '', currentItem: () => null,
    loadDayPlan: () => ({ items: [] }),
  };
  Object.assign(base, overrides);
  return { svc: createWakePromptService(base), calls };
}

test('silentWakeNoteV2：仅群聊的 probability/recovery 给说明', () => {
  const h = ctx();
  assert.match(h.svc.silentWakeNoteV2('group:1', 'probability'), /没有人在跟你说话/);
  assert.match(h.svc.silentWakeNoteV2('group:1', 'recovery:xx'), /没有人在跟你说话/);
  assert.equal(h.svc.silentWakeNoteV2('group:1', 'atMention'), '');
  assert.equal(h.svc.silentWakeNoteV2('private:1', 'probability'), '');
});

test('renderLiveLearningBlocks：owner 纠正写回，私聊带学习项，群聊不带', () => {
  const h = ctx({
    getSocialV2State: () => ({ agentToken: 'tok', recentMessages: [{ text: '你刚才那样不对', isOwner: true }] }),
  });
  const priv = h.svc.renderLiveLearningBlocks('private:123');
  assert.match(priv, /notes-block/);
  assert.match(priv, /items-block/);
  assert.equal(h.calls.added, 1);
  assert.equal(h.calls.saved, 1);
  const group = h.svc.renderLiveLearningBlocks('group:1');
  assert.match(group, /notes-block/);
  assert.doesNotMatch(group, /items-block/);
});

test('buildWakeReminderPromptV2：私聊完整角色卡 + 令牌 + 收尾提醒', () => {
  const h = ctx();
  const text = h.svc.buildWakeReminderPromptV2('private:123');
  assert.match(text, /【当前角色】测试角色/);
  assert.match(text, /role-card-full/);
  assert.match(text, /【会话令牌】tok/);
  assert.match(text, /qq_set_wake_config/);
  assert.match(text, /timeoutMs=300000/);
});

test('buildWakeReminderPromptV2：群聊也整卡注入并带 owner 提醒', () => {
  const h = ctx({ roleHintForMode: () => 'x'.repeat(2000) });
  const text = h.svc.buildWakeReminderPromptV2('group:1');
  assert.match(text, /x{2000}/, '群聊拿到完整角色卡');
  assert.equal(text.includes('其余角色卡私聊里还在'), false, '不再裁剪');
  assert.match(text, /群里只有带【他】标记的才是他本人/);
});
