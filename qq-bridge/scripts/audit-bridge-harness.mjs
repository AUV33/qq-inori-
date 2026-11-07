// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/domain/send/md-to-plain.js';
import * as sensitive from '../src/domain/shared/sensitive.js';
import * as wait from '../src/domain/conversation/v2-wait.js';
import * as safeFetch from '../src/domain/shared/safe-fetch.js';
import * as forward from '../src/domain/conversation/forward.js';
// [INTAKE] bridge.js 在 main() 里就调用 makeLinkCache()，harness 少了它整个 VM 起不来。
import * as intake from '../src/domain/leaves/inori-intake.js';
import * as slang from '../src/domain/social/slang-learner.js';
import * as sticker from '../src/domain/send/sticker-lib.js';
import * as modelPrices from '../src/domain/persona/model-prices.js';
import * as tokenLedger from '../src/domain/memory/token-ledger.js';
import * as voiceLib from '../src/domain/send/send-voice-lib.js';
import * as stateAcl from '../src/domain/shared/state-acl.mjs';
import { unwrap, createTurnCollector } from '../src/adapters/dsh-client.js';

// [MODULE STUBS] bridge.js import 了 30+ 个本地模块。harness 以前只注入 main() 执行路径
// 用到的那些，缺桩要到运行期才以晦涩的 `ReferenceError: xxx is not defined` 暴露
// （一天内踩过四次：lifestate / curiosity / workshop / activity）。现在改为：
// ① bridge.js 引用的**所有**本地模块都注入真命名空间（与 intake/makeLinkCache 先例一致：
//    真模块在调用时才会碰宿主 state，顶层 import 本身无副作用）；
// ② 文末静态守卫校验 bridge.js 每个 import 绑定名都存在于 context，缺桩当场清晰报错；
// ③ 两个确定性覆盖（loadLifeState / createActivityTracker）防止她的实时生活状态与
//    真实活动痕迹渗进测试断言（测试要可重复，不依赖她此刻在干嘛）。
import * as presetPromptMod from '../src/domain/persona/preset-prompt.js';
import * as local3bMod from '../src/domain/memory/local-3b.js'; // [STUB] ensureLocal3b/local3bBase/local3bAlive/startLocal3bSweeper/touchLocal3b
import * as localJudgeMod from '../src/domain/memory/local-judge.js'; // [STUB] fuseJudgement/shouldJudge/judgeByModel
import * as affectExamplesMod from '../src/domain/persona/affect-examples.js'; // [STUB] pickExamples
import * as atSplitMod from '../src/domain/conversation/at-split.js'; // [STUB] pruneSplitQueue
import * as quoteFixMod from '../src/domain/leaves/inori-quote-fix.js'; // [STUB] stripSelfQuoting
import * as memoryExtractMod from '../src/domain/leaves/inori-memory-extract.js'; // [STUB] extractFacts/shouldExtract/DEFAULT_EXTRACT
import * as localAffectClassifierMod from '../src/domain/memory/local-affect-classifier.js'; // [STUB] 情绪小分类器（ONNX）
import * as affectMod from '../src/domain/leaves/inori-affect.js'; // [STUB] detectCues/aggregateFeel/renderFeelHint
import * as roleCardMod from '../src/domain/persona/role-card.js';
import * as memoryRetrieveMod from '../src/domain/memory/memory-retrieve.js';
import * as inoriStyleMod from '../src/domain/leaves/inori-style.js';
import * as selfModelMod from '../src/domain/leaves/inori-selfmodel.js';
import * as groupHabitsMod from '../src/domain/leaves/inori-grouphabits.js';
import * as groupMembersMod from '../src/domain/leaves/inori-groupmembers.js';
import * as peopleIndexMod from '../src/domain/leaves/inori-people.js';
import * as factsMod from '../src/domain/leaves/inori-facts.js';
import * as groupFactsMod from '../src/domain/leaves/inori-group-facts.js'; // [STUB] 群话题：extractTopics/renderGroupTopics
import * as turnSchedulerMod from '../src/domain/conversation/turn-scheduler.js'; // [STUB] [SCHED] planGrants/turnScore
import * as turnPromptMod from '../src/domain/conversation/turn-prompt.js'; // [STUB] prompt/grant 统一生命周期
import * as turnDispatchMod from '../src/domain/conversation/turn-dispatch.js'; // [STUB] 并发槽调度状态机
import * as qualityTrendsMod from '../src/domain/persona/quality-trends.js'; // [STUB] 质量趋势分桶
import * as practiceSlotMod from '../src/domain/social/practice-slot.mjs'; // [STUB] 练手位：pickPracticeSlots/renderPracticeSlots/DEFAULT_MAX_INJECTED
import * as rerankOnDemandMod from '../src/domain/memory/rerank-on-demand.js'; // [STUB] ensureRerank
import * as replyPaceMod from '../src/domain/conversation/reply-pace.js'; // [STUB] [PACE] computeReplyPace
import * as controlRoomMod from '../src/domain/social/control-room.js'; // [STUB] renderControlRoom/buildScenes
import * as thoughtsMod from '../src/domain/leaves/inori-thoughts.js';
import * as taskLedgerMod from '../src/domain/leaves/inori-taskledger.js';
import * as skillOptMod from '../src/domain/leaves/inori-skillopt.js';
import * as activityMod from '../src/domain/leaves/inori-activity.js';
import * as imagegenMod from '../src/domain/leaves/inori-imagegen.js';
import * as gameResourcesMod from '../../ai-companion-kit/packages/shared/game-resources.mjs';
import * as reasoningMod from '../src/domain/leaves/inori-reasoning.js'; // [STUB] 思考链纯逻辑：reasoningTextOf/reasoningTailText/shouldKeepFull/candidateTextFrom
import * as sessionRetainMod from '../src/domain/leaves/inori-session-retain.js'; // [STUB] 会话保留：planRetention/sweepRetention/planStaleArchive/RETENTION_DEFAULTS
import * as outboxMod from '../src/domain/leaves/inori-outbox.js'; // [STUB] 没发出去的话：appendUndelivered/listUndelivered/renderUndeliveredLine
import * as resourceGateMod from '../src/domain/memory/resource-gate.js'; // [STUB] 资源闸门：createResourceGate
import * as usageCapMod from '../src/domain/memory/usage-cap.js'; // [STUB] 每日用量上限：evaluateDailyCap
import * as focusMod from '../src/domain/leaves/inori-focus.js';
import * as aboutSelfMod from '../src/domain/leaves/inori-aboutself.js';
import * as digestMod from '../src/domain/leaves/inori-digest.js';
import * as registerMod from '../src/domain/leaves/inori-register.js';
import * as mediaHintMod from '../src/domain/leaves/inori-media-hint.js';
import * as silentGuardMod from '../src/domain/leaves/inori-silent-guard.js';
import * as stateMoodMod from '../src/domain/leaves/inori-state.js';
import * as moodTopicMod from '../src/domain/leaves/inori-mood-topic.js';
import * as valenceMod from '../src/domain/leaves/inori-valence.js';
import * as goalsMod from '../src/domain/leaves/inori-goals.js';
import * as skillsMod from '../src/domain/leaves/inori-skills.js';
import * as glossMod from '../src/domain/leaves/inori-gloss.js';
import * as learningLoopMod from '../src/domain/leaves/inori-learning-loop.js';
import * as skillVerifyMod from '../src/domain/leaves/inori-skill-verify.js';
import * as sendLedgerMod from '../src/domain/send/send-ledger.js';
import * as outgoingQueueMod from '../src/domain/send/outgoing-queue.mjs'; // [STUB] 纯状态机，直接用真实现
import * as wakeTriggerMod from '../src/domain/conversation/wake-trigger.mjs'; // [STUB] 纯判定，直接用真实现
import * as secretaryMod from '../src/domain/conversation/secretary.mjs'; // [STUB] 秘书预判（纯函数，直接用真实现）
import * as wakeSnapshotMod from '../src/domain/conversation/wake-snapshot.mjs'; // [STUB] 纯渲染，直接用真实现
import * as quantAgentMod from '../src/quant/agent.js'; // [STUB] quantSnapshotLine：纯本地读 config/account
import * as peerBotsMod from '../src/domain/social/peer-bots.mjs'; // [STUB] pickTalkingPeers/renderPeerBotLine（同伴 bot）
import * as sendGuardMod from '../src/domain/send/send-guard.mjs'; // [STUB] 纯判定，直接用真实现
import * as speakGateMod from '../src/domain/conversation/speak-gate.mjs'; // [W-1] 开口时机：纯函数（computeReplyTiming/evaluateSpeakGate）
import * as dayPlanMod from '../src/domain/leaves/inori-dayplan.mjs'; // [A1] 日程卡：纯函数（normalizePlan/renderDayPlanBlock）
import * as behaviorLogMod from '../src/domain/leaves/inori-behavior-log.mjs'; // [BEHAVIOR] 行为日志统计（app.mjs 已引用）
import * as selfEvoMod from '../src/domain/persona/self-evolution-log.mjs'; // [ACTOR] 进化账本读端（只认 her 的改动）
import * as selfEditVerifyMod from '../src/domain/persona/self-edit-verify.mjs'; // [SELF-EDIT-CODE] 改代码的校验规则
import * as floorLogMod from '../src/domain/shared/floor-log.mjs'; // [FLOOR] 回合判定账本（另一会话接入）
import * as selfTuneMod from '../src/domain/persona/self-tune.mjs'; // [SELF-TUNE] 她自己调行为参数（白名单）
import * as stickerAutoMod from '../src/domain/send/sticker-autocollect.mjs'; // [AUTO-PACE] 自动收藏节奏闸（纯函数）
import * as learningWritesMod from '../src/domain/leaves/inori-learning-writes.js'; // [STUB] 纯函数（learning-trend 读端）
import * as wakePromptMod from '../src/domain/persona/wake-prompt.mjs'; // [STUB] prompt 主体（依赖由 app.mjs 注入，自身无 IO）
import * as wakeScheduleMod from '../src/domain/conversation/wake-schedule.mjs'; // [STUB] 调度层（依赖注入，无 IO）
import * as wakeSenderMod from '../src/domain/conversation/wake-sender.mjs'; // [STUB] 唤醒投递（依赖注入，无 IO）
import * as messageIntakeMod from '../src/domain/conversation/message-intake.mjs'; // [STUB] 消息入口状态机（依赖注入）
import * as consoleServerMod from '../src/adapters/console-server.mjs'; // [STUB] HTTP 控制台（依赖注入，无 IO 初始化）
import * as muxBusMod from '../src/adapters/mux-bus.mjs'; // [STUB] 事件总线泵（依赖注入）
import * as turnTakingMod from '../src/domain/conversation/turn-taking.js'; // [STUB] 轮次判断（纯函数，21:32 新增）
import * as lessonsMod from '../src/domain/leaves/inori-lessons.js';
import * as learningItemsMod from '../src/domain/leaves/inori-learning-items.js';
import * as skillDraftsMod from '../src/domain/leaves/inori-skill-drafts.js';
import * as sessionNotesMod from '../src/domain/leaves/inori-session-notes.js';
import * as liveFeedbackMod from '../src/domain/leaves/inori-live-feedback.js';
import * as autonomyMod from '../src/domain/leaves/inori-autonomy.js';
import * as lifeMod from '../src/domain/leaves/inori-lifestate.js';
import * as gateMod from '../src/domain/leaves/inori-gate.js';
import * as curiousMod from '../src/domain/leaves/inori-curiosity.js';
import * as workshopMod from '../src/domain/leaves/inori-workshop.js';
import * as ruminationMod from '../src/domain/leaves/inori-rumination.js';
import * as relationshipMod from '../src/domain/leaves/inori-relationship.js';
import * as reflectMod from '../src/domain/leaves/inori-reflect.js';
import * as adaptMod from '../src/domain/leaves/inori-adapt.js';
import * as memoryCleanMod from '../src/domain/leaves/inori-memory-clean.js';
import * as behaviorLedgerMod from '../src/domain/leaves/inori-behavior-ledger.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
// [TASK-POOL] 任务池纯函数（一个任务一个会话/并行上限/FIFO 队列/超时回收）
import * as taskPoolMod from '../src/domain/leaves/inori-taskpool.js';
// 想做的事（own-life 补位素材）：导出名 recordWish/doneWish… 与 bridge.js 的别名 import 对齐见 aliased
import * as wishMod from '../src/domain/leaves/inori-wish.js';
// 没发出去的文字（挂心事容器）：纯函数，bridge.js 用别名 import（renderUnsentLine→renderUnsent）
import * as unsentMod from '../src/domain/leaves/inori-unsent.js';
import * as worksMod from '../src/domain/leaves/inori-works.js';
import * as browseMod from '../src/domain/leaves/inori-browse.js';
import * as compactMod from '../src/domain/leaves/inori-compact.js';
import * as memMaintMod from '../src/domain/leaves/inori-memory-maint.js';
import * as embedPruneMod from '../src/domain/leaves/inori-embed-prune.js';
import * as socialGraphMod from '../src/domain/leaves/inori-social-graph.js';
import * as browseLearnMod from '../src/domain/leaves/inori-browse-learn.js';
import * as voiceVarietyMod from '../src/domain/leaves/inori-voice-variety.js';
import * as personaCueMod from '../src/domain/leaves/inori-persona-cues.js';
import * as selfTrendMod from '../src/domain/leaves/inori-self-trend.js';
// 遇到不认识的→好奇 / 遇到喜欢的→感兴趣（纯模块）
import * as interestMod from '../src/domain/leaves/inori-interest.js';
// 这句话是不是冲我来的（question 触发 / 必须回判定）
import * as directedMod from '../src/domain/leaves/inori-directed.js';
// 活跃群插话 / 会话延续的时机判定
import * as joinMod from '../src/domain/leaves/inori-join.js';
// 自主行动日志（纯观察模块）：bridge.js 的挂接在测试里必须哑化，
// 否则每次跑审计都会往她的真实日志里灌测试事件（确定性原则，同 createActivityTracker）。
import * as actionLogMod from '../src/domain/leaves/inori-actionlog.js';
import * as snowLumaConnMod from '../src/adapters/snowluma-conn.js';
import * as ownLifeMod from '../src/domain/social/own-life.js';
import * as timeWordsMod from '../src/domain/conversation/time-words.js'; // [TIME-WORDS] humanizeGap/humanizeDuration（app/wake-prompt 会注入）
import * as runtimeTasksMod from '../src/domain/conversation/runtime-tasks.mjs'; // [SPLIT] 任务池/工作台服务
import * as runtimeGateMod from '../src/domain/conversation/runtime-gate.mjs'; // [SPLIT] 注意门服务
process.env.BRIDGE_AUDIT = '1'; // [GATE] 审计不拉起真实 embedding 服务
// 跨仓库共享层（ai-companion-kit）：jsonl 学习库，纯文件读写函数。
import * as learningStoreMod from '../../ai-companion-kit/packages/shared/learning-store.mjs';

// bridge.js 的别名 import（x as y）必须显式绑到正确模块上：
// load/save/tick 这类通用导出名在多个模块的扁平 spread 里会互相遮蔽，别名才可靠。
const aliased = {
  saveLifeFile: lifeMod.saveLifeState, lifeTransition: lifeMod.transition, lifePhysTick: lifeMod.physTick,
  markCuriosityStimulus: lifeMod.curiosityStimulus,
  recordCuriosity: curiousMod.record, forgetCuriosity: curiousMod.forget,
  openCuriosityLoops: curiousMod.openLoops, renderCuriosityLine: curiousMod.renderLine,
  workshopRun: workshopMod.runScript,
  loadMoodState: stateMoodMod.loadState, saveMoodState: stateMoodMod.saveState,
  tickMood: stateMoodMod.tick, noteMoodReply: stateMoodMod.noteReply,
  decideMood: moodTopicMod.decide,
  appraiseValence: valenceMod.appraiseText, describeValence: valenceMod.describe,
  loadGoals: goalsMod.load, saveGoals: goalsMod.save, renderGoals: goalsMod.render,
  expireGoals: goalsMod.expire, addGoalRow: goalsMod.add,
  loadSkills: skillsMod.load, findSkills: skillsMod.find, saveSkills: skillsMod.save, recordSkillResult: skillsMod.recordResult, noteSkillInjected: skillsMod.noteInjected,
  loadFailures: () => ({ events: [] }), saveFailures: () => true, noteFailure: () => ({ evt: {}, cause: { key: 'unknown' }, counted: false }), renderFailureDigest: () => '',
  explainFailure: () => ({ cause: 'unknown', kind: 'unknown', kindLabel: '', fix: '' }), resolveFailure: () => null, renderReflectDigest: () => '',
  isolatedPresetFor: () => 'qq-chat',
  planTurnGrants: () => [], turnSchedulerScore: () => 0,
  computePace: () => ({ factor: 1, holdMs: 1200, scene: 'stub' }),
  sendLedger: { shouldSkip: () => false, note: () => {} },
  resolveReadThrough: (throughSeq, opts = {}) => {
    const last = Number.isSafeInteger(Number(opts.lastUnreadSeq)) ? Number(opts.lastUnreadSeq) : 0;
    const maxSafe = Number.isSafeInteger(Number(opts.max)) ? Number(opts.max) : last;
    const seq = typeof throughSeq === 'number' ? throughSeq : NaN;
    if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, value: null, clamped: false, reason: '非法 throughSeq' };
    if (seq > last) return { ok: false, value: null, clamped: false, reason: 'throughSeq 超过最后一条未读（' + last + '）' };
    if (seq > maxSafe) return { ok: true, value: maxSafe, clamped: true, reason: 'throughSeq 超过可展示水位，已收敛到 ' + maxSafe + '；' + (seq - maxSafe) + ' 条仍未读' };
    return { ok: true, value: seq, clamped: false, reason: '' };
  },
  planOrganize: () => ({}), describePlan: () => '', buildIndex: () => ({}),
  cognition: { load: () => ({}), save: () => true, render: () => '', renderLine: () => '', list: () => [], add: () => ({}), remember: () => ({}) },
  findUnknownTerms: glossMod.findUnknown, renderUnknownTerms: glossMod.renderUnknown,
  loadLessons: lessonsMod.load, renderLessons: lessonsMod.render, selectLessons: lessonsMod.select, selectLessonsForContext: lessonsMod.selectForContext, voteLesson: lessonsMod.vote, inferLessonTrigger: lessonsMod.inferTrigger,
  touchLesson: lessonsMod.touch, rewriteLessons: lessonsMod.rewrite, expireLessons: lessonsMod.expire,
  loadLearningItems: learningItemsMod.load, renderLearningItems: learningItemsMod.render,
  loadSkillDrafts: skillDraftsMod.load, renderSkillDrafts: skillDraftsMod.render,
  loadSessionNotes: sessionNotesMod.load, saveSessionNotes: sessionNotesMod.save, renderSessionNotesBlock: sessionNotesMod.renderBlock,
  addCorrection: sessionNotesMod.addCorrection, addOpenLoop: sessionNotesMod.addOpenLoop, pruneSessionNotes: sessionNotesMod.prune,
  looksLikeCorrection: liveFeedbackMod.looksLikeCorrection, classifyToolError: liveFeedbackMod.classifyToolError,
  renderLiveHint: liveFeedbackMod.renderLiveHint, shouldNoteToolFailure: liveFeedbackMod.shouldNoteToolFailure,
  openLoopText: liveFeedbackMod.openLoopText,
  reflectShouldRun: reflectMod.shouldRun, buildReflectPrompt: reflectMod.buildPrompt,
  checkReflectOutcome: reflectMod.checkOutcome,
  // [WISH] 想做的事：bridge.js 用别名 import（openWishes→openWishItems、markRun→markWishRun）
  recordWish: wishMod.recordWish, doneWish: wishMod.doneWish,
  openWishItems: wishMod.openWishes, dueWishes: wishMod.dueWishes,
  markWishRun: wishMod.markRun, renderWishLine: wishMod.renderWishLine,
  // [UNSENT] 没发出去的文字（去重/14 天期限/容量 5/短句优先）
  sinkUnsent: unsentMod.sinkUnsent, renderUnsent: unsentMod.renderUnsentLine,
  takeExpiredHint: unsentMod.takeExpiredHint,
  isDirectedAtAiPure: directedMod.isDirectedAtAi,
  // [INTEREST] 遇到驱动的兴趣/好奇（纯函数）
  detectLikes: interestMod.detectLikes, recordEncounter: interestMod.recordEncounter,
  renderEncounterLine: interestMod.renderEncounterLine,
  decideJoin: joinMod.decideJoin, decideContinue: joinMod.decideContinue, renderRecentLines: joinMod.renderRecentLines,
};
// 确定性覆盖（排在所有 spread 之后生效）。
const deterministic = {
  // [SEND-GUARD] 发送前相关性检查：测试里放行（返回 null = 拿不到向量，调用方按放行处理）。
  relevanceCos: async () => null,
  // 自身引语剥离（另一处并行改动引入的纯函数）：测试里原样返回。
  stripSelfQuoting: (s) => s,
  // 同类注入块合并：测试里直接放行（不改变被测文本）。
  mergeBlocks: (t) => t,
  // 质量趋势（另一位并行改动引入的模块）：测试里给空结果，不读生产统计。
  buildTrends: () => ({}),
  TREND_SOURCES: [],
  loadLifeState: () => ({ state: 'idle', curiosityStimuli: [] }),
  createActivityTracker: () => ({
    record() {}, lookup() { return []; }, recentApps() { return []; }, finish() { return false; },
  }),
  // 行动日志挂接点哑化：审计跑 bridge.js 时绝不往她的真实日志（或任何真实路径）写事件。
  logAction: () => {},
  // [AUTO-TRACE] 工具失败自动留痕（bridge.js 别名 import appendTrace）：测试不写真实 traces，桩成空操作。
  appendTrace: () => null,
};

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  // 行动日志模块的文件指针指到本测试的临时目录（同一模块实例，行为账读取侧随之隔离）。
  actionLogMod.setLogFile(path.join(temp, 'state', 'action-log.jsonl'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  // 2026-10-28：实现已从 bridge.js 抽到 app.mjs（入口只剩 main() 调用）。
  // harness 要在 VM 里跑的是**实现**，所以读 app.mjs；源码级断言统一走
  // scripts/lib/bridge-source.mjs 的合集（bridge.js + app.mjs + 已抽出的模块）。
  let source = fs.readFileSync(path.join(root, 'src/app.mjs'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  // bridge.js 是 ESM 入口，她会在里面 export 一些助手供测试用；VM 的 Script 不认 export。
  // 顶层 export 只是导出语义，剥掉不影响 VM 内行为（qq-model-view 也做同样处理）。
  source = source.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  source = source.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  // [HARNESS-FIX] 不要在 main() 里自动起控制台 server：每个测试各自用 h.startConsoleServer()
  // 起独立实例。否则每个 harness 都会留下一个永不关闭的 server（原 close() 只清定时器+删临时目录），
  // 多次 harness 串行后累积的残留 server 仍监听着、且临时目录已删，会劫持后续请求并在 handler
  // 读文件时抛错/挂起（表现为 "request hung"）。只去掉自动调用，函数定义与 h.startConsoleServer 入口保留。
  source = source.replace(/startConsoleServer\(\);/g, '/* harness: console server started per-test via h.startConsoleServer */');
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    __QQINORI_MEM_DIR: path.join(temp, 'memory'),
    // [PATHS] bridge.js 已改用 project-paths：VM 里必须指向测试临时目录，
    // 否则审计会往真实仓库写 state/logs。
    STATE_DATA_DIR: path.join(temp, 'state'),
    MEMORY_DIR: path.join(temp, 'memory'),
    LOG_DIR: path.join(temp, 'logs'),
    projectPath: (...parts) => path.join(temp, ...parts),
    stateDataPath: (...parts) => path.join(temp, 'state', ...parts),
    // [CONVERSATIONS] 会话清单只在这种真实会话环境里有意义，审计里桩成空串，
    // 避免提示词断言混入宿主真实会话；清单本身的渲染由 test-inori-sessions 覆盖。
    renderConversations: () => '',
    // [VISION-SERVICE] 看图状态机在审计里不连 DSH：ask 直接失败，handleEvent 不吃事件。
    // [AFFECT-ONNX] / [MEM-EXTRACT] 审计里不打网络、不写记忆：桩成"不可用"
    classifyAffectOnnx: async () => null,
    shouldTrustOnnx: () => false,
    onnxJudgement: () => null,
    // [CONTEXT-PACKET] / [METRICS] 纯模块：审计里给最小实现，不碰真实数据
    buildContextPacket: ({ purpose = 'isolated', content = '' } = {}) => ({ purpose, content, tokens: {}, caps: {} }),
    promptTextOf: (packet) => String(packet?.content ?? ''),
    stripKnownTokens: (text) => ({ text: String(text ?? ''), hits: 0 }),
    collectSessionTokens: () => [],
    computeMetrics: () => ({ windowHours: 24, totals: {}, tokens: {}, perConversation: [], warnings: [] }),
    summarizePrompt: () => ({ total: 0, blockCount: 0, top: [], blocks: [] }),
    formatBudgetLine: () => '',
    budgetWarnings: () => [],
    compactInjection: (text) => text,
    ensureEmotionServer: () => false,
    extractMemoryFacts: async () => ({ prompt: '', facts: [], raw: '' }),
    shouldExtractMemory: () => false,
    completeLocal3b: async () => null,
    // [SCHEMA] 审计里绝不迁移真实数据：桩成空报告
    ensureSchemas: () => ({ changed: [], normalized: [], skipped: [], warnings: [], manifest: {} }),
    // [S2-4] bridge 里 import 起了别名（shouldBlockSilentReplyPure），VM context 也要给名字
    shouldBlockSilentReplyPure: sendGuardMod.shouldBlockSilentReply,
    // [ALIAS] app.mjs 的 import 别名：自动桩按“本地名”找不到模块导出，必须显式映射。
    normalizeImagePrompt: imagegenMod.normalizePrompt,
    normalizeGameResources: gameResourcesMod.normalizeSnapshot,
    mergeGameResources: gameResourcesMod.mergeSnapshot,
    // [CONFIG-CHECK] 体检只读：审计环境里不比对（真实配置在这里没有意义，也不该被读）
    findDroppedKeys: () => [],
    createTaskService: runtimeTasksMod.createTaskService,
    createGateService: runtimeGateMod.createGateService,
    createVisionService: () => ({
      ask: async () => { throw new Error('审计环境不提供看图'); },
      handleEvent: () => false,
      activeSessions: () => [],
      sessions: new Set(),
    }),
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...intake, ...slang, ...sticker,
    // [ALIAS] app.mjs 用 `stickerShortRef as stickerShortRefOf` 跨行别名 import（多行 import 的
    // 局部名不会出现在命名空间展开里，必须显式补；2026-10-28 抽 prompt 主体时炸出来的）
    stickerShortRefOf: sticker.stickerShortRef,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl,
    ...presetPromptMod, ...roleCardMod, ...memoryRetrieveMod, ...inoriStyleMod, ...selfModelMod,
    ...groupHabitsMod, ...groupMembersMod, ...factsMod, ...groupFactsMod, ...turnSchedulerMod, ...turnPromptMod, ...turnDispatchMod, ...qualityTrendsMod, ...practiceSlotMod, ...rerankOnDemandMod, ...replyPaceMod, ...controlRoomMod, ...affectMod, ...localJudgeMod, ...local3bMod, ...affectExamplesMod, ...atSplitMod, ...memoryExtractMod, ...localAffectClassifierMod, ...quoteFixMod, ...thoughtsMod,
    // [STUB] bridge 里的 import 别名（模块导出的是 extractFacts/shouldExtract）
    extractMemoryFacts: memoryExtractMod.extractFacts, shouldExtractMemory: memoryExtractMod.shouldExtract, ...taskLedgerMod,
    ...skillOptMod, ...activityMod, ...reasoningMod, ...sessionRetainMod, ...outboxMod, ...resourceGateMod, ...usageCapMod, ...focusMod, ...aboutSelfMod, ...digestMod, ...registerMod,
    ...stateMoodMod, ...moodTopicMod, ...valenceMod, ...goalsMod, ...skillsMod, ...glossMod, ...learningLoopMod, ...skillVerifyMod, ...sendLedgerMod, ...outgoingQueueMod, ...wakeTriggerMod, ...wakeSnapshotMod, ...secretaryMod, ...sendGuardMod, ...speakGateMod, ...dayPlanMod, ...behaviorLogMod, ...selfEvoMod, ...floorLogMod, ...selfTuneMod, ...stickerAutoMod, selfEditVerifyMod, ...learningWritesMod, ...wakePromptMod, ...wakeScheduleMod, ...wakeSenderMod, ...messageIntakeMod, ...consoleServerMod, ...muxBusMod, ...turnTakingMod,
    // [ALIAS] app.mjs 以 `pumpMux as pumpMuxCore` 导入（命名导入的局部别名，命名空间展开里没有）
    pumpMuxCore: muxBusMod.pumpMux,
    ...lessonsMod, ...autonomyMod, ...lifeMod, ...gateMod, ...curiousMod, ...workshopMod,
    ...quantAgentMod,
    ...peerBotsMod,
    ...ruminationMod, ...relationshipMod, ...reflectMod, ...adaptMod, ...memoryCleanMod, ...behaviorLedgerMod,
    ...mediaHintMod, ...silentGuardMod, ...taskPoolMod,
    ...snowLumaConnMod, ...ownLifeMod, ...timeWordsMod, ...learningStoreMod, ...actionLogMod, ...worksMod, ...browseMod, ...compactMod, ...memMaintMod, ...embedPruneMod, ...socialGraphMod, ...browseLearnMod, ...voiceVarietyMod, ...personaCueMod, ...selfTrendMod,
    peopleIndex: peopleIndexMod,
    // [PERSON-MEMORY] 按人翻记忆：app.mjs 直接引用这两个名字
    aliasesOf: peopleIndexMod.aliasesOf,
    personOf: peopleIndexMod.personOf,
    personAliasesOf: peopleIndexMod.aliasesOf,
    personRecordOf: peopleIndexMod.personOf,
    ...aliased,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    // 确定性覆盖放在最后：loadLifeState / createActivityTracker 不用真 state，保证测试可重复。
    ...deterministic,
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  // [ARCH-MOVE] refactor(arch) 把 qq-model-view.js 归位到 domain/persona/ 后，这里仍按旧路径读，
  // 导致 CI 的 "Bridge regression harness" 步骤 ENOENT 直接退出 1。与 app.mjs 的 import 路径保持一致。
  const modelViewSource = fs.readFileSync(path.join(root, 'src/domain/persona/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  // [静态守卫] bridge.js 从本地模块 import 的每个绑定名都必须存在于 VM context：
  // 以后 bridge.js 新增顶层 import 而这里忘了补桩时，当场给出清晰报错，
  // 而不是在运行期炸出晦涩的 `ReferenceError: xxx is not defined`。
  // （这坑最近一天踩过四次：lifestate / curiosity / workshop / activity。）
  {
    // 2026-10-28：实现搬到了 app.mjs，补桩守卫跟着实现文件走（入口壳没有 import 依赖）。
    const rawBridge = fs.readFileSync(path.join(root, 'src/app.mjs'), 'utf8');
    const missing = [];
    // 支持**多行** import（旧实现按行匹配，`stickerShortRef as stickerShortRefOf` 这类
    // 跨行别名一直漏检，直到 2026-10-28 抽 prompt 主体时被立即求值才炸出来）。
    for (const m of rawBridge.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/gs)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/\/\/.*$/s, '').split(/\s+as\s+/).pop().trim();
        if (name && !Object.prototype.hasOwnProperty.call(context, name) && !missing.includes(name)) missing.push(name);
      }
    }
    for (const m of rawBridge.matchAll(/^import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](\.[^'"]*)['"]/gm)) {
      const name = m[1];
      if (!Object.prototype.hasOwnProperty.call(context, name) && !missing.includes(name)) missing.push(name);
    }
    if (missing.length) {
      // [AUTO-STUB] app.mjs 的本地 import 会不断增长（多个会话并行改），手工维护桩表就是打地鼠：
      // 缺什么就从它所在的模块里 import 什么，只补缺的（已有桩优先，不覆盖测试用的假实现）。
      const auto = {};
      for (const m of rawBridge.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/gs)) {
        const names = m[1].split(',').map((raw) => raw.trim().replace(/\/\/.*$/s, '')).filter(Boolean)
          .map((raw) => {
            const parts = raw.split(/\s+as\s+/);
            return { imported: parts[0].trim(), local: (parts[1] || parts[0]).trim() };
          });
        const need = names.filter((n) => missing.includes(n.local));
        if (!need.length) continue;
        try {
          const mod = await import(pathToFileURL(path.join(root, 'src', m[2])).href);
          for (const n of need) if (n.imported in mod) auto[n.local] = mod[n.imported];
        } catch { /* 模块导入失败就保留缺失 */ }
      }
      for (const m of rawBridge.matchAll(/^import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"](\.[^'"]*)['"]/gm)) {
        const n = m[1];
        if (!missing.includes(n)) continue;
        try {
          const mod = await import(pathToFileURL(path.join(root, 'src', m[2])).href);
          if (n in mod) auto[n] = mod[n];
          else if (mod.default) auto[n] = mod.default;
        } catch { /* 同上 */ }
      }
      if (Object.keys(auto).length) {
        context.__autoStub = auto;
        vm.runInContext('Object.assign(globalThis, globalThis.__autoStub); delete globalThis.__autoStub;', context);
        for (const k of Object.keys(auto)) {
          const i = missing.indexOf(k);
          if (i >= 0) missing.splice(i, 1);
        }
      }
    }
    if (missing.length) {
      throw new Error(
        `审计 harness 缺少本地 import 桩：${missing.join(', ')}（app.mjs 在引用，自动 import 也没补上；检查模块是否导出了这些名字）`,
      );
    }
  }
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  // [HARNESS-FIX] 跟踪所有经 startConsoleServer 起来的 server，close() 时一并关闭，
  // 杜绝残留 server 劫持后续 harness 请求并在临时目录删除后挂起（"request hung"）。
  const consoleServers = new Set();
  const origStartConsoleServer = bridge.startConsoleServer;
  bridge.startConsoleServer = (...args) => {
    const s = origStartConsoleServer(...args);
    if (s && typeof s.on === 'function') {
      consoleServers.add(s);
      s.on('error', () => {}); // 吞掉端口冲突等 error，避免未捕获导致进程崩溃
    }
    return s;
  };
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const s of consoleServers) { try { s.close(); } catch { /* 已关闭 */ } }
    consoleServers.clear();
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
