// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import './domain/shared/best-effort.js'; // [CATCH] 空 catch 统一计数出口
import { createActorRegistry } from './domain/conversation/conversation-actor.mjs';
import { segmentsToText, extractMediaFromSegments, canonicalV2Key } from './domain/shared/cq-segments.mjs';
import { localClock, sleep, convKey, withTimeout } from './domain/shared/pure-utils.mjs';
import { VALID_MODES, normalizeModeInput } from './bootstrap/mode-utils.mjs';
import { readJsonSafe, readConfigObject, atomicWriteJson, atomicWriteText } from './bootstrap/fs-utils.mjs';
import { createBridgeLock } from './bootstrap/bridge-lock.mjs';
import { createAllowlist } from './domain/shared/allowlist.mjs';
import { createStateIo } from './domain/shared/state-io.mjs';
import { CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS, keyForAgentToken, rememberAgentToken, forgetAgentToken } from './bootstrap/agent-tokens.mjs';
import { createSessionKindStore, createConsoleTokenStore } from './bootstrap/runtime-state.mjs';
import { createDiaryHelpers } from './bootstrap/diary-helpers.mjs';
import { createLifeState } from './bootstrap/life-state.mjs';
import { loadConfig, normalizeOwnerQQ } from './bootstrap/config.mjs';
import { normalizeReasoningEffort, isSilentMarker, redactSensitiveText, escapeCqText, readActivityTail as readActivityTailFile, REASONING_EFFORT_DEFAULT, REASONING_EFFORT_OPTIONS } from './bootstrap/text-utils.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process'; // [WIRING-FIX] execFile 原来没导入，手机状态探测一取就炸
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './domain/persona/preset-prompt.js';
import { roleCharStats, roleSectionReport } from './domain/persona/role-card.js';
import { createRolePresetStore, applyRoleInjectLimit, ROLE_INJECT_MAX_CHARS_DEFAULT } from './domain/persona/role-preset-store.mjs';
import { createPlanRunner, createLoggingStepExecutor, createDSHPlanExecutor } from './kernel/plan-runner.mjs'; // [G1] 长程规划执行器（门控挂载，默认不启用）
import { createVoiceService } from './domain/send/voice-service.mjs';
import { createUnreadState } from './domain/conversation/unread-state.mjs';
import { createImageService } from './domain/send/image-service.mjs';
import { createStickerService } from './domain/social/sticker-service.mjs';
import { planSocialTimeline } from './domain/send/send-format.mjs';
import { createOneBotTransport } from './adapters/onebot-transport.mjs';
import { createSendService } from './domain/send/send-service.mjs';
import { createSessionTelemetry } from './domain/conversation/session-telemetry.mjs';
import { createSessionPolicy } from './domain/conversation/session-policy.mjs';
import { createSessionRetire } from './domain/conversation/session-retire.mjs';
import { createSessionCreate } from './domain/conversation/session-create.mjs';
import { createGroupWindow } from './domain/social/group-window.mjs';
import { createSocialFormat } from './domain/social/social-format.mjs';
import { createSocialState } from './domain/social/social-state.mjs';
import { createWakePromptService } from './domain/conversation/wake-prompt-service.mjs';
import { createSelfKnowledge } from './domain/persona/self-knowledge.mjs';
import { foldSelfAnchor, renderSelfAnchorLine } from './domain/mind/self-anchor.mjs';
import { createReplyCheck } from './domain/conversation/reply-check.mjs';
import { createSocialAppend } from './domain/social/social-append.mjs';
import { createGroupMemory } from './domain/social/group-memory.mjs';
import { createGroupFacts } from './domain/social/group-facts.mjs';
import { createSocialLoop } from './domain/social/social-loop.mjs';
import { createPendingService } from './domain/conversation/pending-service.mjs';
import { createDigestService } from './domain/memory/digest-service.mjs';
import { createBusyWatchdog } from './domain/conversation/busy-watchdog.mjs';
import { createSocialCore } from './domain/social/social-core.mjs';
import { createReflectionService } from './domain/memory/reflection-service.mjs';
import { createLiveFeedback } from './domain/conversation/live-feedback-service.mjs';
import { createOwnLifeService } from './domain/social/ownlife-service.mjs';
import { createRoleHint } from './domain/persona/role-hint.mjs';
import { createIntakeService } from './domain/conversation/intake-service.mjs';
import { createToolLearning } from './domain/memory/tool-learning-service.mjs';
import { createMaintenance } from './domain/shared/maintenance-service.mjs';
import { createControlRoom } from './domain/social/control-room-service.mjs';
import { createSocialTiming } from './domain/social/social-timing-service.mjs';
import { createMemberLookup } from './domain/social/member-lookup-service.mjs';
import { createReplyTarget } from './domain/conversation/reply-target-service.mjs';
import { createSocialRecords } from './domain/social/social-records-service.mjs';
import { createToolRedaction } from './domain/memory/tool-redaction-service.mjs';
import { createWakeAffect } from './domain/conversation/wake-affect-service.mjs';
import { createReasoningService } from './domain/memory/reasoning-service.mjs';
import { createSelfContext } from './domain/memory/self-context-service.mjs';
import { createWakeRuntime } from './domain/conversation/wake-runtime.mjs';
import { createPromptCandidates } from './domain/memory/prompt-candidates-service.mjs';
import { createSnowLumaToken } from './adapters/snowluma-token-service.mjs';
import { createSlangContext } from './domain/social/slang-context-service.mjs';
import { createIsolatedSession } from './domain/conversation/isolated-session-service.mjs';
import { createTransientSession } from './domain/conversation/transient-session-service.mjs';
import { createSendPipeline } from './domain/send/send-pipeline-service.mjs';
import { createMediaService, MAX_MEDIA_PIXELS } from './domain/send/media-service.mjs';
import { createStickerPool } from './domain/social/sticker-pool-service.mjs';
import { createMemoryOrganize } from './domain/memory/memory-organize-service.mjs';
import { createSlangLearnerRuntime } from './domain/social/slang-learner-runtime.mjs';
import { createModelCatalog } from './domain/persona/model-catalog-service.mjs';
import { createSessionModel } from './domain/conversation/session-model-service.mjs';
import { createOwnLifeDispatch } from './domain/social/ownlife-dispatch-service.mjs';
import { createBrowseService } from './domain/send/browse-service.mjs';
import { createWakeConfig } from './domain/conversation/wake-config-service.mjs';
import { createModeRefresh } from './domain/conversation/mode-refresh-service.mjs';
import { createSlangStore } from './domain/social/slang-store-service.mjs';
import { createSnowLumaWatchdog } from './adapters/snowluma-watchdog-service.mjs';
import { createSlangSessionLifecycle } from './domain/social/slang-session-lifecycle.mjs';
import { createWakeExtraLines } from './domain/persona/wake-extra-lines.mjs';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector } from './adapters/dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './domain/send/md-to-plain.js';
// [MEMORY-INJECT] 本地长期记忆检索（语义优先，服务不可用自动退回字面）
import { recallBlock, recall, filesForScope, loadEntries, buildRecallQuery, filterEntriesByPerson, appendUtterance, pruneUtterances, canonScope } from './domain/memory/memory-retrieve.js';
// [IDLE-ASSOC] 独处联想：从记忆图里随机走一条线，附在“自己的时间”提示末尾。
import { buildAssociationGraph, idleAssociations, renderAssociationBlock } from './domain/memory/assoc-activation.mjs';
// [RAW] 原文层 + 结构化主张（承诺/偏好/冲突/计划）
import { appendRaw, pruneRaw, extractClaims, claimToMemoryRow } from './domain/leaves/inori-raw-memory.mjs';
// [PERSON-MEMORY] 按 QQ 翻记忆（人物索引的跨群昵称 + 记忆库文本匹配）
import { aliasesOf as personAliasesOf, personOf as personRecordOf } from './domain/leaves/inori-people.js';
// [RERANK-ONDEMAND] 交叉重排服务 8792 的按需拉起（不再常驻、不再 60s 保活）
import { ensureRerank } from './domain/memory/rerank-on-demand.js';
// [IMAGEGEN] 生图后端「按需拉起」：真要用才把 sd-server 拉起来，闲 idleMs 就关（省显存/内存）
import { createImageGen, freeMemMB } from './domain/leaves/inori-imagegen.js';
// [SEND-LEDGER] 发送幂等账本：桥接被重启后，同一句话不会被发两遍
import * as sendLedger from './domain/send/send-ledger.js';
// [S2-1] 出站串行队列 + 每会话失败记账（原来散在 main() 闭包里的 sendChain/lastSendFailed）
import { createOutgoingQueue } from './domain/send/outgoing-queue.mjs';
// [ONEBOT-GUARD] 入站事件形状校验 + message_id 幂等（借鉴 dsh-onebot 的 receive/duplicate）
import { createInboundGate, pokeDedupeKey } from './onebot/inbound-gate.mjs';
// [ONEBOT-HEARTBEAT] 心跳看护：连接假死时主动重连（借鉴 dsh-onebot 的 armHeartbeat）
import { createHeartbeatWatch } from './onebot/heartbeat.mjs';
// [SESSION-RETAIN] 会话目录保留策略：DSH 只归档不删，会话目录只增不减（详见模块头注释）
import { planRetention, sweepRetention, planStaleArchive, planOrphanRetention, RETENTION_DEFAULTS } from './domain/leaves/inori-session-retain.js';
// [SEND-GUARD] 群聊发送前的「接得上吗」检查（宽松 0.25，拿不到向量就放行）
import { relevanceCos } from './domain/send/send-relevance.js';
// [RESTART-GATE] 重启闸门：createBridge 里会把它换成真实的「有没有回合在跑」判定。
// 重启请求先回 200，再等到空闲（默认最多 60s）才真正退出——避免把在途回合拦腰砍断。
let anyTurnBusyProbe = () => false;
// [EMBED-GUARD] 同一时刻只允许一个 llama-server 拉起动作：桥接里有两处会拉它
// （启动时 watchdog + 门循环 gateEmbedStart），外面还有 9-启动嵌入服务.bat。
// 抢不到端口的实例不会自己退出，每个白占约 0.95 GB 提交（2026-10-27 实测 3 个并存）。
let embedSpawnClaimAt = 0;
// [ONEBOT-GUARD] 入站闸门 / 心跳看护的只读快照，供控制台 /api/status 查看。
// 在 main() 里赋值；未启动时为 null（控制台不用判空两次）。
let oneBotHealth = null;
function claimEmbedSpawn() {
  if (Date.now() - embedSpawnClaimAt < 90000) return false; // 90 秒内已有人拉过（可能正在载模）
  embedSpawnClaimAt = Date.now();
  return true;
}
// [CLAUSE] 分条：把逗号长句拆回多条气泡（依据真人基线统计）
import { splitClauses } from './domain/leaves/inori-style.js';
// [SELF-MODEL] 她最近的样子：经验/话风/追人/做事汇总成自我认识
import { buildSelfModel, renderSelfModel, isSameLocalDay } from './domain/leaves/inori-selfmodel.js';
import { computeReplyTiming, REPLY_DEBOUNCE_MS, evaluateSpeakGate } from './domain/conversation/speak-gate.mjs';
// [ACTOR] 进化账本读端：只认她自己改的（修假自画像）
import { pickHerRecentEdit, describeEdit } from './domain/persona/self-evolution-log.mjs';
// [SELF-EDIT-CODE] 她改自己代码的判定规则（纯函数，console 侧注入）
import * as selfEditVerifyMod from './domain/persona/self-edit-verify.mjs';
import { summarizeLearningWrites, renderLearningWritesLine } from './domain/leaves/inori-learning-writes.js';
 // [SELF-WRITES] learning-trend 的读端
import { composeSelfSnapshot } from './domain/leaves/inori-self-snapshot.js';
import { buildFreedomPolicy, formatFreedomLog, renderFreedomPermission } from './domain/leaves/inori-freedom.js';
import { recordFreedomPolicy } from './domain/social/freedom-monitor.js';
import { loadIntentions, renderIntentionsBlock } from './domain/leaves/inori-intentions.js';
import { buildIntentionCandidates, renderIntentionCandidates } from './domain/leaves/inori-intention-candidates.js';
import { readOutcomes, renderOutcomesBlock } from './domain/leaves/inori-outcome.js';
import { classifyPragmaticFrame, renderPragmaticBlock } from './domain/leaves/inori-pragmatics.js';
import { createDiscourseState, updateDiscourseState, renderDiscourseBlock } from './domain/leaves/inori-discourse-state.js';
import { applyEmotionCalibration, detectEmotionCorrection, recordEmotionFeedback } from './domain/leaves/inori-emotion-calibration.js';
import { appraiseSelfEmotion, buildEmpathicStance, renderSelfEmotionBlock } from './domain/leaves/inori-self-emotion.js';
import { readLanguageEpisodes, findLanguageEpisodesByContext, renderLanguageEpisodeBlock } from './domain/leaves/inori-language-episodes.js';
import { summarizeBehavior, renderBehaviorLogLine, behaviorDigestRow } from './domain/leaves/inori-behavior-log.mjs';
 // [BEHAVIOR-LOG] 她做过的事
// [GROUP-HABITS] 群习惯档案：每个群怎么聊（节奏/复读率/表情率/常用短语）
import { computeGroupHabits, renderGroupHabits } from './domain/leaves/inori-grouphabits.js';
// [GROUP-MEMBERS] 群里每个人：发言统计 + 规则印象标签
import { noteMember, renderMembers, memberNickLookup } from './domain/leaves/inori-groupmembers.js';
// [PEOPLE] 全局人物索引：跨群归一 + 她的持久印象之家 + 按人应答指引（确定性）
import * as peopleIndex from './domain/leaves/inori-people.js';
// [FACTS] 关于他的稳定事实：从私聊里自动提炼（生日/喜好/习惯/住处/称谓/关系/雷区）
import { extractFacts, dedupeFacts, sanitizeFact } from './domain/leaves/inori-facts.js';
// [THOUGHTS] 她自己的念头：从独处/反思回合里捕获，跨会话延续
import { appendThought, extractThoughtLines, renderThoughts, similarThoughtCount, addGoalIdea, renderGoalIdeas } from './domain/leaves/inori-thoughts.js';
// [TASK-LEDGER] 任务台账：交付登记、完成回写、唤醒提醒
import { appendTask, finishTask, renderLedger, retaskToQueued, queuedCount, parseTaskResult, resumeTask, findResumableTask } from './domain/leaves/inori-taskledger.js';
// [TASK-POOL] 任务池：一个任务一个会话、并行上限 + FIFO 队列（纯函数状态机）
import { poolCap, queueMax, canDispatch } from './domain/leaves/inori-taskpool.js';
// [SKILL-OPT] 技能优化（不是淘汰）：失败写改进点+降置信度，成功升置信度
import { optimizeSkill } from './domain/leaves/inori-skillopt.js';
// [ACTIVITY] 活动轨迹：她玩手机/操作时自动记录 → 下次自动复用（ExpeL 式经验池）
import { createActivityTrackerRegistry, isPhoneTool, renderTraceHint, renderInsightHints, writeReflectInsight, summarizeGroupSpeakers } from './domain/leaves/inori-activity.js';
// [REASONING] 思考链纯逻辑（取思考 / 挑摘要 / 是否留全文或经验候选）
import { appendUndelivered, listUndelivered, renderUndeliveredLine } from './domain/leaves/inori-outbox.js';
 // [OUTBOX] 没发出去的话不再静默丢
import { append as appendTrace, recent as recentTraces } from './domain/leaves/inori-traces.js';
import { detectSkillCandidates, renderSkillCandidates } from './domain/leaves/inori-skill-candidates.js';
import { loadWorks, findWork, activeWorks, runningWorks, queuedWorks, addProgress, setWorkStatus, summarizeWorkerText, renderWorksLine, WORK_STATUS, conditionedRoleText } from './domain/leaves/inori-works.js';
import { loadBrowse, saveBrowse, newBrowseEntry, noteBrowse, pendingBrowse, renderBrowseDigest, markBrowseOutcome, hasContent, renderWanderNudge } from './domain/leaves/inori-browse.js';
import { extractTerms } from './domain/leaves/inori-browse-learn.js';
import { renderVoiceVarietyHint } from './domain/leaves/inori-voice-variety.js';
import { renderPersonaCue } from './domain/leaves/inori-persona-cues.js';
import { renderConversations } from './domain/leaves/inori-sessions.js';
import { createTurnDispatch } from './domain/conversation/turn-dispatch.js';
import { buildTrends, TREND_SOURCES } from './domain/persona/quality-trends.js';
import { ensureSchemas } from './domain/shared/schema-version.js';
// [CONFIG-CHECK] 白名单加载器的"静默丢弃"体检：只读、只告警，不挡启动
import { findDroppedKeys } from './config-check.mjs';
import { createVisionService } from './domain/send/vision-service.js';
import { maintainMemoryDir } from './domain/leaves/inori-memory-maint.js';
import { pruneEmbeddingCaches } from './domain/leaves/inori-embed-prune.js';
import { loadSocialGraph, saveSocialGraph, noteEdge, renderGraphLine, polarityOf } from './domain/leaves/inori-social-graph.js';
// [MEM-ORGANIZE] 记忆库有序整理（机械识别：旧快照/重复/索引）
import { planOrganize } from './domain/leaves/inori-memory-organize.js';
// [COGNITION] 认知条目：她提炼的、跨事件稳定的判断
import * as cognition from './domain/leaves/inori-cognition.js';
// [KNOWLEDGE] 从查到记：反复查过、还没写成认知的外部知识（纯函数，数据源是 tool-calls.jsonl）
import { collectLookups, pickCandidates, renderCandidates } from './domain/leaves/inori-knowledge.mjs';
// [QUOTE-CONTEXT] 有人引用她那条时，递回她发那条之前的前文（纯函数叶子模块）
import { buildQuoteContext } from './domain/leaves/inori-quote-context.mjs';
// [SELF-RECENT] 跨会话自我连续性：她在别处说过/做过的事
import { renderSelfRecent } from './domain/leaves/inori-self-recent.mjs';
import { summarizeSelfTrend, renderSelfTrend } from './domain/leaves/inori-self-trend.js';

// [MEM-DIR] 记忆目录单一来源：审计 VM 通过 globalThis.__QQINORI_MEM_DIR 指到临时目录，
// 环境变量 INORI_MEMORY_DIR 可覆盖（默认数据目录）——测试不再写真实记忆。
const MEM_DIR = (typeof globalThis !== 'undefined' && globalThis.__QQINORI_MEM_DIR)
  || (typeof process !== 'undefined' && process.env && process.env.INORI_MEMORY_DIR)
  || MEMORY_DIR;
// [WIRING-FIX] 这个常量以前只以对象属性形式出现在 createSocialFormat 的依赖里（`MEMORY_FILE: ...`），
// 而 socialFormat 用 `getMemoryFile: () => MEMORY_FILE` 读的是变量 → 每次读记忆都 ReferenceError。
const MEMORY_FILE = MEM_DIR + '/memory.jsonl';

// [SOCIAL-GRAPH] 他人↔他人关系图谱：引用回复/邻接成对统计（她自己那份在人物档案里）
const SOCIAL_GRAPH_FILE = stateDataPath('social-graph.json');
let socialGraph = loadSocialGraph(SOCIAL_GRAPH_FILE);
let socialGraphSaveTimer = null;
function saveSocialGraphSoon() {
  if (socialGraphSaveTimer) return;
  socialGraphSaveTimer = setTimeout(() => {
    socialGraphSaveTimer = null;
    try { saveSocialGraph(SOCIAL_GRAPH_FILE, socialGraph); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:144'); }
  }, 5000);
  socialGraphSaveTimer.unref?.();
}
import { parseFocusBlock, renderFocusBlock, loadFocus, saveFocusBlock, FOCUS_SLOTS, FOCUS_SLOT_CN } from './domain/leaves/inori-focus.js';

// [ABOUT-SELF] 「有人在说我」的判定已随唤醒触发一起抽到 wake-trigger.mjs（S2-2）
// [DIGEST] 每日消息摘要（分层摘要第一层，解决 100 条以外消息消失）
import { digestDay, alreadyDigested } from './domain/leaves/inori-digest.js';

// [BEHAVIOR-LEDGER] 夜间反思的「行为账」素材：五处散账汇成一行事实。
// 此前漏 import——bridge.js 顶层按模块名引用会在每夜反思时静默 ReferenceError，
// 被 try/catch 吞掉，行为账层永远缺席（审计 2026-10-25 发现）。
import { renderBehaviorLedger } from './domain/leaves/inori-behavior-ledger.js';

// [ACTION-LOG] 自主行动日志：每个决策点记一条事实（纯观察，零行为约束）
import { logAction } from './domain/leaves/inori-actionlog.js';

// [STORE] 学习产物唯一写入口（原子写 + 锁 + 趋势）
import { appendJsonl, withFileLock, writeJsonDocument, writeTextAtomic } from '../../ai-companion-kit/packages/shared/learning-store.mjs';

// [STYLE] 语域学习：从场合量出目标句长，再看自己偏了多少
import { computeStyleStats, targetFromScene, evaluateStyle, describeStyle, questionHint } from './domain/leaves/inori-register.js';

// [MOOD] 她自己的状态（温度/精力）+ 话题分类 → 回复倾向
import { loadState as loadMoodState, saveState as saveMoodState, tick as tickMood, noteReply as noteMoodReply, stateWithKey, effectiveWarmth } from './domain/leaves/inori-state.js';
import { classifyTopic, decide as decideMood, moodLine } from './domain/leaves/inori-mood-topic.js';

// [MOOD] NRC-VAD 负向强度（只读本地 NRC-VAD 词表，不复制）
import { appraiseText as appraiseValence } from './domain/leaves/inori-valence.js';

// [GOALS] 她手上的事（目标栈）：目标 + 进度 + 过期，让她独处时有连续性而不是每次从零开始
import { load as loadGoals, save as saveGoals, render as renderGoals, renderOpenInvitation as renderGoalOpenInvitation, expire as expireGoals, add as addGoalRow } from './domain/leaves/inori-goals.js';

// [SKILLS] 她学过的做法（技能库）：按当前话题检索命中才注入（Voyager 式的技能复用）
import { load as loadSkills, find as findSkills, save as saveSkills, applyOutcome, noteInjected as noteSkillInjected } from './domain/leaves/inori-skills.js';

// [PRACTICE-QUIET] 练手位挑选规则（试过太多次的不再每小时推）
import { pickPracticeSlots, renderPracticeSlots, DEFAULT_MAX_INJECTED } from './domain/social/practice-slot.mjs';
import { renderActivityMenu } from './domain/conversation/activity-menu.mjs';

// [ADDRESSED-JUDGE] 唤醒时先分清这轮是不是在说她（群聊才注入）
import { addressedJudgmentLine } from './domain/conversation/addressed-judgment.mjs';

// [GAME-RESOURCES] 游戏家底账本（只收数字 + 账号标签；密码/验证码/token 类进不来）
import { normalizeSnapshot as normalizeGameResources, mergeSnapshot as mergeGameResources } from '../../ai-companion-kit/packages/shared/game-resources.mjs';
import { checkVerify } from './domain/leaves/inori-skill-verify.js';

// [FAIL-DIGEST] 失败原因实时归纳（工具失败 → 分类 → 唤醒里递一句）
import { load as loadFailures, save as saveFailures, noteFailure, classifyFailure } from './domain/leaves/inori-failures.js';
import { createPhoneProbe, selectAdb, renderPhoneLine } from './domain/leaves/inori-phone-availability.js';
 // [PHONE-STATE] 手机现在能不能用（60s 缓存）
import { LOG_DIR, MEMORY_DIR, STATE_DATA_DIR, projectPath, stateDataPath } from './domain/shared/project-paths.js';
import { seedFromOldSystem } from './kernel/seed-from-oldstate.mjs';
import { isSendToolName } from './domain/shared/tool-flags.js';
import { buildDecisionContext, contextEventRow, contextSummary } from './domain/mind/decision-context.mjs';
import { selectIntention } from './domain/mind/meta-controller.mjs';
import { createLifeLoop } from './domain/life/life-loop.mjs';
import { createMindRuntime } from './domain/mind/mind-runtime.mjs';
// [LIFE-RECONCILE] S4：启动即对一次账（内核影子态 vs state-hub 真实态），偏差进日志。
import { compareLifeStates } from './domain/mind/life-reconcile.mjs';
// [AUTHORITY] S4b：字段唯一写者矩阵（双写字段在切主前必须收敛）。
import { authorityReport } from './domain/mind/life-authority.mjs';
// [DUAL-READ/WRITE] S4b-2/3：双写标量的读取收敛 + 写回 state-hub。
import { createKernelRuntimePorts } from './domain/mind/kernel-runtime-ports.mjs';
// [DRIVE-GATE] S4b-4：drive 必须是可审计判定，不能靠改字符串“以为已经接管”。
import { evaluateDriveGate, formatDriveGate } from './domain/mind/life-drive-gate.mjs';
// [LESSONS-LEDGER] 宪章 §5.4：内核反思产物写入教训账（append-only，来源 kernel-shadow）。
import { createLessonsLedger, buildCandidate as buildLessonCandidate, LESSON_LEDGER_FILE } from './domain/mind/lessons-ledger.mjs';
import { planExpression } from './domain/mind/expression-policy.mjs';
import { classifyDirected } from './domain/mind/engagement-metrics.mjs';
import { decideQualityPolicy } from './domain/mind/quality-policy.mjs';
import { summarizeOffline } from './domain/mind/offline-narrative.mjs';
import { computeAttentionBias } from './domain/mind/attention-bias.mjs';

// [FLOOR-LOG] 每次「该不该开口」判定落盘（调阈值/回算被接住率用；写失败不挡唤醒）
import { createFloorLog } from './domain/shared/floor-log.mjs';

// [SELF-TUNE] 她自己调行为参数（白名单 + 硬边界；改完下一轮判定即生效）
import { createTuningReader, TUNE_PARAMS, readTuningFile, applyTuning } from './domain/persona/self-tune.mjs';

// [AUTO-PACE] 自动收藏节奏闸（日额度 + 小时额度 + 最小间隔，纯函数有单测）
import { evaluateAutoCollect, evaluateCaptionRetry } from './domain/send/sticker-autocollect.mjs';
 // [STICKER-FIX] 6524 行在用 evaluateCaptionRetry，重构时漏了 import
// [FAIL-REFLECT] 失败反思：能力/策略/环境归因 + 解决追踪
import { explainFailure, resolveFailure } from './domain/leaves/inori-failure-reflect.js';

// [GLOSS] 未知词检测：把「她没见过但反复出现的词」递到她面前（不自欺：提示词写'偶尔搜'等于永远不搜）
import { findUnknown as findUnknownTerms, renderUnknown as renderUnknownTerms } from './domain/leaves/inori-gloss.js';

// [SLANG-POLICY] 黑话提取触发策略：有生词信号就 10 分钟提前，否则按普通冷却
import { decideSlangExtraction, hasUrgentSignal } from './domain/leaves/inori-slang-policy.js';

// [LESSONS] 她的经验（关于自己的认知）：量小、长期有效，所以常驻注入而不是按需检索
import { load as loadLessons, selectForContext as selectLessonsForContext, render as renderLessons, inferTrigger as inferLessonTrigger, touch as touchLesson, vote as voteLesson, rewrite as rewriteLessons, expire as expireLessons } from './domain/leaves/inori-lessons.js';

// [LEARNING-ITEMS] 她自己选的“想学/想练”的事（一次只练一件）
import { load as loadLearningItems, render as renderLearningItems, shouldInjectIntoPrompt as shouldInjectLearningItem } from './domain/leaves/inori-learning-items.js';
import { recent as recentPractice } from './domain/leaves/inori-practice.js';
import { renderWeeklyReview } from './domain/leaves/inori-learning-review.js';

// [SKILL-DRAFTS] 练习通过后生成的技能草稿（她改/收/拒）
import { load as loadSkillDrafts, render as renderSkillDrafts } from './domain/leaves/inori-skill-drafts.js';

// [SESSION-NOTES] 实时层：他刚纠正了什么、上次没做完的是什么、下一步
import { load as loadSessionNotes, save as saveSessionNotes, renderBlock as renderSessionNotesBlock, addCorrection, addOpenLoop, clearOpenLoops, prune as pruneSessionNotes } from './domain/leaves/inori-session-notes.js';
import { looksLikeCorrection, classifyToolError, renderLiveHint, shouldNoteToolFailure, openLoopText } from './domain/leaves/inori-live-feedback.js';
import { buildAutonomyPrompt } from './domain/leaves/inori-autonomy.js';

// [LIFE] 生活状态机 + 生理层（灵活作息：状态由代码算，话语只叙述；熬夜会留下债）
import { saveLifeState as saveLifeFile, detectSleepClaim, detectLateSleepClaim, mayOwnWake, renderLifeLine, renderReflectLine, renderTimeLine, drowsinessOf, boredomOf, markInterest, curiosityStimulus as markCuriosityStimulus } from './domain/leaves/inori-lifestate.js';
import { parseGateReply } from './domain/leaves/inori-gate.js';
import { record as recordCuriosity, forget as forgetCuriosity, openLoops as openCuriosityLoops, renderLine as renderCuriosityLine } from './domain/leaves/inori-curiosity.js';

// [TIME-WORDS] 时间说人话（刚刚/N 分钟前/N 小时前/昨天/N 天前）——唤醒状态行与目标年龄共用
import { humanizeGap } from './domain/conversation/time-words.js';

// [DAYPLAN] 今天的安排由她自己定（qq_day_plan 写、wake prompt 读），纯函数在模块里，落盘在这里。
import { normalizePlan, dayKeyOf, currentItem, renderDayPlanBlock } from './domain/leaves/inori-dayplan.mjs';
import { detectLikes, recordEncounter } from './domain/leaves/inori-interest.js';

// [WORKSHOP] 她的工坊：给自己写小工具/小游戏的空间（沙箱执行 + 工坊目录隔离）
import { runScript as workshopRun, listWorkshop, readWorkshop, writeWorkshop, deleteWorkshop } from './domain/leaves/inori-workshop.js';

// [RUMINATE] 情绪反刍：强事件的余温（自我批评/被纠正/任务失败），确定性衰减后再注入
import { detectRumination, addRumination, renderRuminations } from './domain/leaves/inori-rumination.js';

// [DIRECTED] "这句话是不是冲我来的"（question 触发 / 必须回判定 / 未读计数）：纯函数，可单测

// [S2-2] 唤醒触发判定（每条群消息都跑）：纯函数 + 可注入 random，有单测锁
import { evaluateWakeTriggerV2, messageAtsSelf } from './domain/conversation/wake-trigger.mjs';

// [S2-3] 唤醒消息快照的文本渲染（纯函数，格式契约有单测）
import { renderWakeSnapshotV2, buildWakeSnapshot } from './domain/conversation/wake-snapshot.mjs';

// [S2-4] 发送权限快照 + 静默闸门（安全相关，有单测锁"什么时候必须取消发送"）
import { createSendGuard, shouldBlockSilentReply as shouldBlockSilentReplyPure } from './domain/send/send-guard.mjs';
import { planGrants as planTurnGrants } from './domain/conversation/turn-scheduler.js';
 // [SCHED] 并发槽派发策略（有单测锁）
import { submitTurnPrompt } from './domain/conversation/turn-prompt.js';

// [P2-2] 资源门：内存/CPU 紧张时低优先级后台让路（默认 observeOnly，只记不打）
import { createResourceGate, kindOfLabel } from './domain/memory/resource-gate.js';

// [DISK-GUARD] 磁盘资源门：C 盘水位与 %TEMP% 快照只观测，默认不删不挡（2026-10-31 事故）
import { createDiskGuard } from './domain/leaves/inori-disk-guard.js';

// [P2-3] token 日预算判定（纯函数：超额只放聊天、停后台）
import { evaluateDailyCap } from './domain/memory/usage-cap.js';
import { computeReplyPace as computePace, assumeMoreComing } from './domain/conversation/reply-pace.js';
 // [PACE] 节奏 + [WAIT-NEXT] 要不要等下一句（都有单测锁）
// [FLOOR] 运行时轮次判断：这句冲谁说、现在轮不轮到我（替代人设卡节奏死规矩）
import { shouldWake } from './domain/conversation/turn-taking.js';
import { aggregateFeel, renderFeelHint } from './domain/leaves/inori-affect.js';
 // [AFFECT] 情绪线索（有单测锁）
import { fuseJudgement, shouldJudge, judgeByModel, correctTarget } from './domain/memory/local-judge.js';
 // [LOCAL-JUDGE] 规则+已有3B 编排（有单测锁）
import { pickExamples } from './domain/persona/affect-examples.js';
 // [AFFECT] 少样本示例检索（用已有 bge-m3，不新增模型）
import { ensureLocal3b, local3bBase, local3bAlive, startLocal3bSweeper, touchLocal3b, completeLocal3b } from './domain/memory/local-3b.js';
 // [LOCAL-3B] 已有模型按需起/闲置退
import { extractFacts as extractMemoryFacts, shouldExtract as shouldExtractMemory, DEFAULT_EXTRACT } from './domain/leaves/inori-memory-extract.js';
 // [MEM-EXTRACT] 本地 3B 确定性记忆抽取
import { classifyAffectOnnx, ensureEmotionServer, shouldTrustOnnx, onnxJudgement } from './domain/memory/local-affect-classifier.js';
 // [AFFECT-ONNX] 情绪小分类器（3B 不可用时兜底）
import { buildContextPacket, promptTextOf, stripKnownTokens, collectSessionTokens } from './domain/conversation/context-packet.js';
 // [CONTEXT-PACKET] 上下文与权限分离
import { computeMetrics } from './domain/shared/runtime-metrics.js';
 // [METRICS] 行为指标
import { summarizePrompt, formatBudgetLine, budgetWarnings, mergeBlocks, compactInjection, SAFE_INJECTION_CAPS, enforceInjectionBudget, SCENE_BUDGETS } from './domain/persona/prompt-budget.js';
 // [PROMPT-BUDGET] 注入层分块计量 + 同类块合并 + 安全瘦身
import { lookupHintFor } from './domain/persona/prompt-catalog.js';
 // [LOOKUP] 提示词里的「能自己查」目录：被截断/被丢的块挂可追回入口
import { buildScenes, renderOpsLine } from './domain/social/control-room.js';
 // [CONTROL-ROOM] 调度事实行
// [M-1] 唤醒 prompt 主体（350 行注入拼装）已抽成独立模块，这里只传依赖快照

// [SECRETARY] 唤醒前的语义门（纯函数在 secretary.mjs；模型调用在下方 secretaryJudgeForWake）
import { shouldConsultSecretary, buildSecretaryPrompt, parseSecretaryVerdict, secretaryAllows } from './domain/conversation/secretary.mjs';

// [M-1] 调度层（何时叫醒 / 等多久 / 什么时候重试）已抽出，懒构造

// [M-1] 唤醒投递（组装注入层 + 预算 + 投递 + 重试）已抽出，懒构造

// [PEER-BOT] 同类识别：群里名单里的「人」其实是别的 AI（config.socialV2.knownBots），纯函数
import { pickTalkingPeers, renderPeerBotLine } from './domain/social/peer-bots.mjs';

// [M-1] 消息入口状态机（收消息 → 去重/白名单/媒体/触发判定 → 投递）已抽出，懒构造
import { createMessageIntake } from './domain/conversation/message-intake.mjs';
import { runIsolated as mailboxEnqueue, setCrashHandler, recoverMailbox } from './domain/conversation/session-mailbox.mjs';
// [M5] 失败域心跳：某会话邮箱崩溃后 5s 自动尝试恢复并重放孤儿事件；其他会话不受影响。
setCrashHandler((key) => setTimeout(() => { recoverMailbox(key).catch(() => {}); }, 5000));
import { runParallel } from './domain/conversation/task-parallel.mjs';
import { createTaskService } from './domain/conversation/runtime-tasks.mjs';
import { createGateService } from './domain/conversation/runtime-gate.mjs';

// [M-1] HTTP 控制台（3100 的全部路由）已抽出：依赖用 getter/setter 活绑定，模块内赋值会写回
import { startConsoleServerCore } from './adapters/console-server.mjs';

// [M-1] 事件总线（mux 帧泵 + 工具调用/审批/待答）已抽出
import { pumpMux as pumpMuxCore } from './adapters/mux-bus.mjs';
import { pruneSplitQueue } from './domain/conversation/at-split.js';
 // [AT-SPLIT] 队列修剪（有单测锁）
import { stripSelfQuoting } from './domain/leaves/inori-quote-fix.js';
 // [QUOTE-FIX] 她把自己的话用「」包住时剥掉（有单测锁）

// [JOIN] 活跃群插话 + 会话延续（她说完别人接着说）的时机判定：纯函数，可单测
import { decideJoin, decideContinue, renderRecentLines } from './domain/leaves/inori-join.js';
import { summarizeRelationship, renderRelationship } from './domain/leaves/inori-relationship.js';

// [SELF-WAKE] 她想自己干的事（愿望容器 + 自唤醒排期）：她记、她关，系统只记得住+到点叫醒
import { recordWish, doneWish, openWishes as openWishItems, dueWishes, markRun as markWishRun, renderWishLine } from './domain/leaves/inori-wish.js';

// [UNSENT] 没发出去的文字：容器语义（去重/14 天期限/容量 5/短句优先）在纯模块里，可单测
import { sinkUnsent, renderUnsentLine as renderUnsent, takeExpiredHint } from './domain/leaves/inori-unsent.js';


// [TDZ] 基础路径常量必须早于第一个使用它们的顶层工厂调用（createStateIo）。
// Wave 3 把工厂调用放在 import 区之后，但常量原先还在 543 行，ESM 顶层顺序执行时
// `STATE_DIR` 命中暂时性死区：ReferenceError: Cannot access 'STATE_DIR' before initialization，
// 桥接在加载阶段就崩。纯函数单测抓不到，只有冒烟加载 / bridge regression harness 会暴露。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');

// 纯工具 + 文件态读写（实现已抽到 src/domain/shared/state-io.mjs，2026-11-07 Wave 3）
// 保留模块级细委托绑定，以守住 test-app-facade-wiring 的源码契约。
const stateIo = createStateIo({ STATE_DIR, STATE_DATA_DIR, writeJsonDocument, atomicWriteJson, readJsonSafe, log });
const {
  loadWishState, saveWishState, loadInterestEncounters, saveInterestEncounters,
  loadUnsentState, saveUnsentState, readRoleState, writeRoleState,
  unquoteJsonString, stripUrls, sanitizeRoleName, oneBotError,
} = stateIo;


// [UNSENT] 挂心事沉底（2026-10-25 用户拍板 a）：no-send 的补发提醒 10 分钟过期后
// 不再「遗忘」，沉到底部容器——她 own-life/自唤醒时带一行，送不送她定。
// 纪律同 curiosity/wish：只递事实+许可，不新唤醒、不催不派活。
function sinkUnsentHint(text, at, key) {
  try {
    const s = loadUnsentState();
    // 去重/14 天期限/容量 5/短句优先都在 inori-unsent.js，这里只管读写
    if (sinkUnsent(s, { text, at, key }, Date.now())) saveUnsentState(s);
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:307'); }
}
function renderUnsentLine(nowTs) {
  try { return renderUnsent(loadUnsentState(), nowTs || Date.now()); } catch { return null; }
}
// [FORCE-NAP] 最近一条进来的消息时刻：强制小睡要求「至少 20 分钟没人找她」。
let lastIncomingAt = Date.now();
// [DEAD-CODE] 2026-11-03 删掉这里的 `recentClaimTexts`：去重集合的真身在
// social-records-service.mjs（抽取后遗留的空 Set，全文件零读写）。
const life = createLifeState({ log, getLastIncomingAt: () => lastIncomingAt });
// [LIFE-SENSE] 内核 sense 口：由局部生命周期块写入、由入站 handler 读取（跨作用域）。
const lifeSenseHolder = { current: null };
// [SELF-THREAD] 内核 selfThread 的写入口：由 reflect 结果调用；kernel 不在时为 no-op。
const selfThreadEmitterHolder = { current: null };
function lifeNote(ev, opts) { return life.note(ev, opts); }
function getLifeState() { return life.get(); }
function touchLifeInterest() { return life.touchInterest(); }
function startLifePhysTimer() { return life.startPhysTimer(); }
function lifeTimePre() { return life.lifeTimePre(); }
startLifePhysTimer();

// ── [DIARY] 每日日记：22:30 她一天将尽时，桥接发起一次"日记会话"────────────
// 设计（主人定）：不是碎片，是较长且详细的当日记录 + 总结。
// 她直接写在会话输出里（不靠工具、不受 300 字限制），桥接捕获后落盘：
//   真值 data/diary/daily.jsonl（一行一天）+ 桌面 txt 追加"完整记录"段
// 约束：一天一次（写过错就跳过）；睡着不写（lifestate 门）；不往 QQ 发。
const diaryHelpers = createDiaryHelpers({
  dailyFile: projectPath('data', 'diary', 'daily.jsonl'),
  desktopDir: process.env.QQ_INORI_DIARY_DIR || projectPath('data', 'diary', 'desktop'),
  attemptsFile: stateDataPath('diary-attempts.json'),
  log,
});
const { diaryAttempts, dropDiaryAttempt, bumpDiaryAttempts, appendDailyDiary, todayDiaryWritten } = diaryHelpers;
const diarySessions = new Map(); // sessionId -> day（等待捕获输出）

// [RUMINATE] 情绪反刍注入：某会话"她一直惦记着的事"（近 24h、未消化、强度过线才出）
function ruminationPre(key) {
  try {
    const st = getSocialV2State(key);
    const recentSelf = (st?.recentMessages ?? [])
      .filter((m) => m && m.isSelf && String(m.text || '').trim())
      .map((m) => String(m.text))
      .slice(-10);
    return renderRuminations(stateDataPath('ruminations.jsonl'), recentSelf);
  } catch { return ''; }
}
// [REFLECT] 夜间反思的纯逻辑（时间窗/提示词/产出判定）
import { shouldRun as reflectShouldRun, buildPrompt as buildReflectPrompt, checkOutcome as checkReflectOutcome } from './domain/leaves/inori-reflect.js';

// [INTAKE] 每轮学习 + 信息接收（链接读取、新颖度判定、节流）
import { extractLinks, shouldIntake, buildIntakePrompt, buildLinkDigest, makeLinkCache } from './domain/leaves/inori-intake.js';

// [ADAPT] 参数自适应：追发的回报率 → 调整每天追几次
import { computeChaseAdapt, describeAdapt } from './domain/leaves/inori-adapt.js';
import { SENSITIVE_RE } from './domain/shared/sensitive.js';

// [MEM-CLEAN] 群摘要清洗：去 CQ 码/控制字符/纯占位，合并同人发言、去重、限长
import { buildGroupDigest, withWindow, cleanText, cleanMemberName } from './domain/leaves/inori-memory-clean.js';
import { looksLikeUnfinished } from './domain/conversation/v2-wait.js';
import { compactModelMessage } from './domain/persona/qq-model-view.js';
import { safeFetch, safeFetchBuffer, looksLikeImageBuffer } from './domain/shared/safe-fetch.js';
import { cleanupTemp, describeAudio, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing } from './domain/send/send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './adapters/snowluma-conn.js';
import { hardenDir, manualDirCommand } from './domain/shared/state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './domain/conversation/forward.js';
import { resolvePriceTable } from './domain/persona/model-prices.js';
import { createTokenLedger } from './domain/memory/token-ledger.js';
import { loadSlang, saveSlang, upsertSlangEntry, buildSlangContext, buildExtractionPrompt, buildResearchPrompt, parseExtractionJson, parseResearchJson, createSlangEntry, mergeEvidence, pendingJudgeList, judgeSlangEntry, renderSlangJudgeLine, autoPromoteSlang, SLANG_STATUS, SLANG_MAX_ENTRIES } from './domain/social/slang-learner.js';
import { recordSlangUsage, recordSkillAttempt, summarizeLearning, renderLearningDigest } from './domain/leaves/inori-learning-loop.js';
import { loadStickerStore, saveStickerStore, mergeStickerLibrary, findSticker, formatStickerList, buildStickerContext, buildStickerStrategyHint, pickStickerByQuery, stickerShortRef as stickerShortRefOf, applyStickerNote, markStickerUsed, stickerEmptyBoxHint, parseStickerCaption } from './domain/send/sticker-lib.js';

// [IMAGE-HINT] 图片「看了可以记」提示（纯函数：事实+许可，空窗返回 null）
import { imageHintLine } from './domain/leaves/inori-media-hint.js';
import { silentGuardLine } from './domain/leaves/inori-silent-guard.js';

// OWN_LIFE：她自己的生活（定时静默唤醒）——本地手工接入，非上游代码。
// 模块本身来自 ai-companion-kit/packages/own-life，未改动过。
import { createOwnLife } from './domain/social/own-life.js';

// [QUANT] 独处时递一行量化快照（纯本地读，不联网、不催她下单）
import { quantSnapshotLine } from './quant/agent.js';


// __dirname / ROOT / STATE_DIR 已提前到首个顶层工厂调用之前（见上方 [TDZ]）。
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const UNDELIVERED_FILE = stateDataPath('undelivered.jsonl'); // [OUTBOX] 发送失败的话（最多 50 条 / 10 分钟）
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
// [P2-1] 调度丢弃记账：后台小时预算/日预算丢掉的派发都落这里，便于复盘。
const BACKGROUND_DROPS_FILE = path.join(STATE_DIR, 'background-drops.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
// [DAYPLAN] 她那天的安排：她通过 qq_day_plan 自己写；这里只读，读不到就是「今天还没定」。
const DAY_PLAN_FILE = path.join(STATE_DIR, 'day-plan.json');
function loadDayPlan() {
  try { return normalizePlan(JSON.parse(fs.readFileSync(DAY_PLAN_FILE, 'utf8'))); } catch { return normalizePlan({}); }
}

function requireMemoryEntries(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-40);
  } catch { return []; }
}
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

const sessionKindsStore = createSessionKindStore({
  file: path.join(STATE_DIR, 'session-kinds.json'),
  writeJson: atomicWriteJson,
});
const getSessionKinds = () => sessionKindsStore.kinds;
function recordSessionKind(sid, kind) { sessionKindsStore.record(sid, kind); }

const consoleTokenStore = createConsoleTokenStore({ stateDir: STATE_DIR, writeText: atomicWriteText });
function loadOrCreateConsoleToken() { return consoleTokenStore.loadOrCreate(); }
function wasConsoleTokenCreatedOnLoad() { return consoleTokenStore.wasCreated(); }

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) { return readActivityTailFile(ACTIVITY_LOG, n); }

// ── 人格文件与仿真预设：读写/校验/备份在 role-preset-store.mjs（P3-1a 搬出）──
// app 只保留「注入上限」这一份可变状态；模块每次通过 getInjectMaxChars() 读当前值。
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;

const {
  ROLES_DIR,
  ROLE_NAME_MAX,
  ROLE_CONTENT_MAX_BYTES,
  PRESET_NAMES,
  listRoles,
  roleFilePath,
  firstMeaningfulLine,
  roleWarnings,
  roleSummaries,
  validateRoleName,
  validateRoleContent,
  readRoleContent,
  writeRoleContent,
  presetSourceYaml,
  // [WIRING-FIX] 2026-11-03：consoleDeps 的 PRESET_BACKUP_DIR getter 需要这个名字在作用域里存在
  PRESET_BACKUP_DIR,
  dshHomeDir,
  installedPresetYaml,
  readPresetPromptText,
  presetBackupPrefix,
  backupPresetFile,
  listPresetBackups,
  presetStatus,
} = createRolePresetStore({
  root: ROOT,
  stateDir: STATE_DIR,
  atomicWriteText,
  sanitizeRoleName,
  getInjectMaxChars: () => roleInjectMaxChars,
});
import { isolatedPresetFor } from './domain/leaves/inori-isolated-preset.js';
import { extractTopics, renderGroupTopics, parseFactsJson } from './domain/leaves/inori-group-facts.js';


// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';


// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
// 名单单一来源在 tool-flags.js（含表情/语音/拍一拍/生图，避免两处漂移）。

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;






// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// [MEMORY-INJECT] 检索/分类前先把 URL 剔掉：他发链接时，网址本身是语义噪声
// （实测 query=https://api.xiaoheih… 曾把「生日」记忆检索出来，属误伤而非命中）

// [CHASE] 追人定时器：她主动说过话、对方一直没回时，隔几分钟追一句。
// 目的不是刷存在感，而是让"主动"有由头 —— 唤醒 prompt 本来就带
// 【你想说但还没说的】【进行中的话题】，那就是她开口的理由。
// 硬约束：每天 ≤3 次；连续 2 次没得到回应就停手，等对方先开口；0–8 点不追。
const chaseTimers = new Map();
// [SCOPE-FIX] 顶层 chase/adapt 函数需要配置，但 cfg 是 main() 的局部变量。
// 以前这些函数直接写 cfg → 一调用就 "cfg is not defined"（错误被 try/catch 吞掉，
// 所以 chase 从未生效、adapt 从未有样本）。这里用模块级引用，main() 里赋值。
let cfgRef = null;
// [CONFIG-CHECK] loadConfig 读到的「原始文件对象」留一份，供体检/离线诊断比对（不参与运行逻辑）
// [ACTIVITY] 活动轨迹记录器：她每次 phone_* 调用喂进去，一轮结束产出 trace + 洞见
const activityTracker = createActivityTrackerRegistry();
function chaseState(st) {
  const day = new Date().toLocaleDateString('sv-SE');
  if (!st.chase || st.chase.day !== day) st.chase = { day, count: 0, unanswered: 0 };
  return st.chase;
}
// [ADAPT] 自适应上限：存在 data/state/adapt.json，重启后仍然有效
const ADAPT_STATE_FILE = stateDataPath('adapt.json');
let chaseAdaptMax = null;
try {
  const j = JSON.parse(fs.readFileSync(ADAPT_STATE_FILE, 'utf8'));
  if (Number(j?.chaseMaxPerDay) > 0) chaseAdaptMax = Number(j.chaseMaxPerDay);
} catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:1095'); }
function saveAdaptState(patch) {
  try {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(ADAPT_STATE_FILE, 'utf8')); } catch { cur = {}; }
    const r = writeJsonDocument(ADAPT_STATE_FILE, { ...cur, ...patch, at: new Date().toISOString() }, { source: 'bridge/adapt' });
    if (r && r.ok === false) log(`[adapt] 保存失败：${r.error ?? '未知错误'}`);
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:1101'); }
}
function adaptChase(cs, currentMax) {
  try {
    const r = computeChaseAdapt(cs.count, cs.unanswered, currentMax, cfgRef?.socialV2?.chase?.adapt ?? {});
    log(`[adapt] ${describeAdapt(r)}`);
    if (r.ok && r.changed) {
      chaseAdaptMax = r.maxPerDay;
      saveAdaptState({ chaseMaxPerDay: r.maxPerDay, replyRate: r.replyRate, samples: cs.count });
    }
  } catch (error) {
    log(`[adapt] 自适应失败（已忽略）: ${error?.message ?? error}`);
  }
}

function cancelChaseV2(key, why) {
  const t = chaseTimers.get(key);
  if (!t) return false;
  clearTimeout(t);
  chaseTimers.delete(key);
  if (why) log(`[chase] 取消 ${key}（${why}）`);
  return true;
}
function scheduleChaseV2(key, sentAt) {
  const c = cfgRef?.socialV2?.chase ?? {};
  if (c.enabled === false) return;
  if (!String(key).startsWith('private:')) return;
  if (chaseTimers.has(key)) return;
  let st;
  try { st = getSocialV2State(key); } catch { return; }
  const cs = chaseState(st);
  const maxPerDay = Number(chaseAdaptMax) > 0 ? Number(chaseAdaptMax) : (Number(c.maxPerDay) || 3);
  if (cs.count >= maxPerDay) return;
  if (cs.unanswered >= 2) return;
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 8) return;
  const minMs = Math.max(60000, Number(c.minMs) || 5 * 60 * 1000);
  const maxMs = Math.max(minMs, Number(c.maxMs) || 10 * 60 * 1000);
  const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  log(`[chase] 计划 ${Math.round(delay / 60000)} 分钟后追问（今日 ${cs.count}/${maxPerDay}，连续未回 ${cs.unanswered}）`);
  const timer = setTimeout(() => {
    chaseTimers.delete(key);
    try {
      const cur = getSocialV2State(key);
      if ((Number(cur.lastIncomingAt) || 0) > sentAt) { log(`[chase] ${key} 对方已回，不追`); return; }
      if (isConversationBusyV2(key, cur)) { log(`[chase] ${key} 会话忙，跳过本次追问`); return; }
      const s2 = chaseState(cur);
      s2.count += 1;
      s2.unanswered += 1;
      saveSocialV2State();
      adaptChase(s2, maxPerDay);
      log(`[chase] ${key} 追问 ${s2.count}/${maxPerDay}（连续未回 ${s2.unanswered}）`);
      void scheduleWakeV2(key, 'chase');
    } catch (error) { log(`[chase] 追问失败（忽略）: ${error?.message ?? error}`); }
  }, delay);
  timer.unref?.();
  chaseTimers.set(key, timer);
}

let state = { sessions: {} };
let stateWritable = true;


function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁（实现已抽到 src/bootstrap/bridge-lock.mjs，2026-11-06 Wave 1）──
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）：锁文件存 PID，
// 启动时若该 PID 仍存活则退出（exit 2 = 已有实例），否则接管；进程退出/崩溃后锁自动失效。
// 这里保留模块级细委托绑定，以守住 test-app-facade-wiring 的源码契约
// （consoleDeps 的 `get releaseLock() { return releaseLock; }` 要求 releaseLock 在 app.mjs 内可声明/导入）。
const bridgeLock = createBridgeLock({ STATE_DIR, ROOT });
const { acquireLock, releaseLock } = bridgeLock;


// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:1712'); }
  };
}


const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:1738'); }
  appendBridgeLog(`${line}\n`);
}
const SEND_TIMEOUT_MS = 15000;
// [WIRING-FIX] 单条消息媒体字节上限的单一来源：media-service / sticker-pool / 控制台都读它。
// 以前这个常量只在 media-service 内部定义，app.mjs 里却直接引用（未声明 → 取用时 ReferenceError）。
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
// [WIRING-FIX] 媒体元数据缓存上限的单一来源（原来只在 media-service 内部定义，app.mjs 却裸引用）
const MAX_MEDIA_STORE_PER_KEY = 500;

// [SPLIT] segmentsToText / extractMediaFromSegments 已迁至 ./domain/shared/cq-segments.mjs（行为不变）

// [ALLOWLIST] 外部可编辑名单：只有名单里的会话才会进入后端（状态、记忆、唤醒、模型全都碰不到）。
// 文件存在且至少有一条有效条目时，**以文件为准**（覆盖 config.json 的 allow.*），
// 这样加人只要改一行文本，不用碰 JSON、不用记格式。
// 格式：每行一条 `private:<QQ号>` 或 `group:<群号>`，`#` 开头是注释，空行忽略。
// allowlist（实现已抽到 src/domain/shared/allowlist.mjs，2026-11-07 Wave 2）
// 保留模块级细委托绑定，以守住 test-app-facade-wiring 的源码契约
// （consoleDeps 的 `get readWallEntries()` / `get writeWallEntries()` / `get allowed()` 需这些标识符在 app.mjs 内可声明/导入）。
const allowlist = createAllowlist({ ROOT, writeTextAtomic, log });
const { readWallEntries, writeWallEntries, allowed } = allowlist;


// [SPLIT] canonicalV2Key 已迁至 ./domain/shared/cq-segments.mjs（行为不变）

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  // [SMOKE] 冒烟测试钩子（self-edit-guard 用，比 node --check 严一层）：
  // 模块顶层（含文件尾行）全部求值完才会走到 main() 的调用点——在这里立即返回：
  // 不抢锁、不连 DSH、不写状态，进程自然退出（code 0）= 全文件可加载。
  // 为什么必须有它：裸顶层标识符（如 MARKER-LIFE-TEST）解析通过、运行时才 ReferenceError
  // 崩掉 24/7 进程（2026-10-25 凌晨真实发生，--check 拦不住）。
  if (process.env.BRIDGE_SMOKE_TEST === '1') {
    console.log('[bridge] SMOKE_OK（顶层已完整加载，未启动）');
    return;
  }
  const loadedConfig = loadConfig({ root: ROOT, log });
  const cfg = loadedConfig.cfg;
  const rawConfigFile = loadedConfig.raw;
  roleInjectMaxChars = loadedConfig.roleInjectMaxChars;
  cfgRef = cfg; // [SCOPE-FIX] 供模块顶层的 chase/adapt 函数使用

  // [CONFIG-CHECK] 离线体检入口（scripts/config-doctor.mjs --runtime）：
  // 只加载配置、打印结果就退出——不建状态目录、不抢锁、不连 DSH、不写任何文件。
  if (process.env.BRIDGE_CONFIG_CHECK === '1') {
    let dropped = [];
    let error = null;
    try { dropped = findDroppedKeys(rawConfigFile ?? {}, cfg); } catch (e) { error = String(e?.message ?? e); }
    console.log(`[config-check] ${JSON.stringify({ dropped, error })}`);
    process.exit(0);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // [GROUNDWORK] 认知地基（蓝图 v2 R0）：生命线 + 自我状态 + 信念库。
  // 只做启动事件与状态初始化，不参与任何消息决策；失败不阻塞 24/7 启动。
  let mindGroundwork = null;
  let mindStateHub = null;
  let resourceGovernor = null;
  try {
    // [MIND-RUNTIME] 认知地基 + 状态中枢 + 资源治理统一在独立模块装配，app.mjs 只拿结果。
    const runtime = await createMindRuntime({ log, now: () => Date.now() });
    const groundwork = runtime.groundwork;
    const boot = runtime.boot;
    mindGroundwork = groundwork;
    mindStateHub = runtime.stateHub;
    resourceGovernor = runtime.governor;
    log('[groundwork] 认知地基就绪：生命线 ' + boot.lifeLog.events + ' 条，自我状态「' + boot.selfState + '」，信念 ' + boot.people + ' 人/' + boot.groups + ' 群');
    if (boot.narrative) log('[mind] 离线叙事：' + boot.narrative);
    // [MIND-ORIENT] 醒来定向（影子）：只记录“她现在最想做什么”，不执行任何动作。
    try {
      const hour = new Date().getHours();
      const night = hour >= 22 || hour < 7;
      const bootCtx = buildDecisionContext({
        key: '', scene: 'life', at: Date.now(),
        producers: { self: () => groundwork.selfState, belief: () => null },
      });
      const orient = selectIntention(bootCtx, { now: Date.now(), night, idleMs: 6 * 3600 * 1000 });
      groundwork.lifeLog.append({
        type: 'intention.shadow',
        payload: {
          selected: orient.selected ? orient.selected.type : null,
          reason: orient.reason,
          candidates: orient.candidates.map((c) => c.type),
          night,
        },
      }, { at: Date.now() });
      log('[mind] 醒来定向：' + (orient.selected ? orient.selected.type + '（' + orient.reason + '）' : '暂无（' + orient.reason + '）'));
    } catch (error) {
      log('[mind] 醒来定向失败（影子，忽略）: ' + (error?.message ?? error));
    }
    // [LIFE-SENSE] 入站消息镜像到内核 sense（影子/驾驶模式都只读；不改变旧路径）。
    // 注意：sense 口在下面的局部块里创建，入站 handler 在另一段作用域；用模块级 holder 传，避免 ReferenceError。
    // [LIFE-LOOP] 生命循环：60s 推进自我状态并持久化，1h 写检查点。失败不阻塞。
    try {
      // [KERNEL-SHADOW] 绞杀者 P1：同一拍把状态交给生命内核做影子推演。
      // 默认关闭；开启时用 createKernelRuntimePorts：state 落 data/state/mind/kernel-state.json（独立文件），
      // events 内存、act 不发消息、sense 空、memory 不谎报；初始态用 seedFromOldSystem 从真实旧状态起步，
      // trace 落独立 jsonl 供逐字段对账。drive 的真实发送端口在 S4b 接通前不启用。
      // 零行为变更：内核失败只记日志，绝不回写任何既有状态。
      // [LIFE-MODE] 宪章 S4：生命内核唯一开关（旧的 kernel.shadow 旋钮已移除）。life.mode 优先：
      // drive 在真实端口接好前与 shadow 同行为（只推演、不接管），日志会明确标注。
      let shadowKernel = null;
      let shadowTrace = null;
      let planRunner = null; // [G1] 长程规划执行器（外层声明，供 onTick 闭包引用；默认不挂载）
      const lifeCfg = cfgRef?.life && typeof cfgRef.life === 'object' ? cfgRef.life : {};
      const requestedLifeMode = ['shadow', 'drive'].includes(lifeCfg.mode)
        ? lifeCfg.mode
        : 'off';
      let lifeMode = requestedLifeMode;
      if (requestedLifeMode === 'drive') {
        // 真实 act/memory 端口、24h 观察、对账数据都还没接：必然被拒，降级 shadow。
        const gate = evaluateDriveGate({
          requestedMode: 'drive', observationHours: 0, actReal: false, memoryReal: false, errors: 0, reconcile: null,
        });
        log(`[life] ${formatDriveGate(gate)}`);
        lifeMode = gate.effectiveMode;
      }
      if (lifeMode !== 'off') {
        try {
          const shadowFile = projectPath('data', 'reports', 'kernel-shadow.jsonl');
          // 影子起点用真实旧系统状态（best-effort 映射；旧 selfState 部分字段不可靠，仅用于对账观察）。
          // 注意：若 data/state/mind/kernel-state.json 已存在会优先于 seed（内核态跨重启持久化）；
          //       做干净对账前删掉它，让本拍从真实旧状态重新起步。
          // curiosityCount 来自旧 curiosity.json 的 loops 长度（store 缺文件时回退 []，不影响）。
          const curiosityData = (groundwork.store && typeof groundwork.store.readJson === 'function')
            ? groundwork.store.readJson('curiosity.json', { loops: [] })
            : { loops: [] };
          const curiosityCount = Array.isArray(curiosityData?.loops) ? curiosityData.loops.length : 0;
          const shadowSelfState = (mindGroundwork && mindGroundwork.selfState) || null;
          const shadowSeed = seedFromOldSystem({
            loadMoodState,
            moodFile: cfgRef?.socialV2?.mood?.file,
            selfState: shadowSelfState,
            curiosityCount,
            sleeping: !!(shadowSelfState && shadowSelfState.sleeping),
          });
          const shadowPorts = createKernelRuntimePorts({
            at: Date.now(),
            store: groundwork.store,
            hub: mindStateHub,
            log,
          });
          lifeSenseHolder.current = shadowPorts.sense;
          shadowKernel = groundwork.createKernel({
            ports: shadowPorts,
            initial: shadowSeed,
            reflectMs: Number(lifeCfg.reflectMs) > 0 ? Number(lifeCfg.reflectMs) : 6 * 3600 * 1000,
            reflectWindowMs: Number(lifeCfg.reflectWindowMs) > 0 ? Number(lifeCfg.reflectWindowMs) : 24 * 3600 * 1000,
            goalStaleMs: Number(lifeCfg.goalStaleMs) > 0 ? Number(lifeCfg.goalStaleMs) : 14 * 24 * 3600 * 1000,
          });
          // [G1] 长程规划执行器：仅在 life.planRunner 开启时挂载（默认关闭，零行为变更）。
          //   - 'dsh' 模式：真实执行——每个 tick 驱动一次 DSH 会话（LLM 决策并调 qq_* 工具），等待式拿 observation 写回 plan.step。
          //   - 其他真值：影子模式——只记录 plan 生命周期，不执行外部动作（验证内核闭环用）。
          if (lifeCfg.planRunner) {
            try {
              let executeStep;
              if (lifeCfg.planRunner === 'dsh') {
                const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('DSH 步骤超时')), ms))]);
                const runStep = async (index, plan, ctx) => {
                  const key = `plan:${plan.goalId || plan.id}`;
                  const sessionId = await ensureSession(key);
                  const history = (plan.steps || []).map((s) => `第${s.index}步[${s.intention}]：${s.observation || '无记录'}`).join('\n') || '（无）';
                  const promptText = `【长程任务执行】目标：${plan.text}\n已完成步骤：\n${history}\n\n现在执行第 ${index} 步。请调用合适的 qq_* 工具完成这步工作；`
                    + `完成后用一行【OBS】开头的话总结你做了什么和结果。若整体任务完成，结尾加【DONE】；若无法继续，说【FAIL】并说明原因。`;
                  // [PROMPT-LIFECYCLE] 走唯一包装器：plan 步骤也必须申请/释放调度 grant，
                  // 不能裸调 api.sessions.prompt 绕过预算与 turn slot（接线纪律静态锁会拦截）。
                  const res = await withTimeout(
                    submitPromptWithTurnSlot({ sessionId, label: 'isolated:plan', kind: 'background', content: [{ type: 'text', text: promptText }] }),
                    Number(lifeCfg.planStepTimeoutMs ?? 90000),
                  );
                  const text = String(res?.value?.command?.text || res?.text || JSON.stringify(res?.value || res || ''));
                  if (/【FAIL】|\[FAIL\]/.test(text)) return { ok: true, done: true, note: 'LLM 判定无法继续', observation: text.slice(0, 500) };
                  return { ok: true, observation: text.slice(0, 500), done: /【DONE】|\[DONE\]/.test(text) };
                };
                executeStep = createDSHPlanExecutor({ runStep, log: (m) => log(`[plan-dsh] ${m}`) });
                log('[plan-runner] 已挂载（DSH 真实执行模式：每步驱动一次会话调 qq_* 工具）');
              } else {
                executeStep = createLoggingStepExecutor((m) => log(`[plan-runner] ${m}`));
                log('[plan-runner] 已挂载（影子模式：仅记录 plan 生命周期，不执行外部动作）');
              }
              planRunner = createPlanRunner({ kernel: shadowKernel, executeStep });
            } catch (error) { log('[plan-runner] 挂载失败（忽略）: ' + (error?.message ?? error)); }
          }
          // [SELF-THREAD] 只由 reflect 结果写入；reasoning 摘要不走这里。
          selfThreadEmitterHolder.current = (thought, at) => {
            try {
              const text = String(thought ?? '').trim().slice(0, 240);
              if (!text) return;
              shadowKernel.emit('self_thread.updated', { thought: text }, Number(at) || Date.now());
            } catch (error) { log('[self-thread] 写入失败（忽略）: ' + (error?.message ?? error)); }
          };
          shadowTrace = (tr) => {
            try {
              // 字段对齐 state-hub：供 life-reconcile 做逐字段偏差（不再只对 energy/hunger 两个标量）。
              const line = JSON.stringify({
                at: tr.at, intention: tr.decision?.selected, source: tr.decision?.source, reason: tr.decision?.reason,
                energy: shadowKernel.state.energy, hunger: shadowKernel.state.socialHunger,
                curiosity: shadowKernel.state.curiosity, stress: shadowKernel.state.stress,
                valence: shadowKernel.state.valence, mood: shadowKernel.state.mood,
                attention: shadowKernel.state.attention, selfTrust: shadowKernel.state.selfTrust,
                affect: shadowKernel.state.affect, goals: shadowKernel.state.goals.length,
                commitments: shadowKernel.state.commitments.length, lastInitiateAt: shadowKernel.state.lastInitiateAt,
                lessons: shadowKernel.state.lessons.length, refs: shadowKernel.state.lessonRefs.length, failed: tr.failed,
              }) + '\n';
              fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
              fs.appendFileSync(shadowFile, line, 'utf8');
            } catch { /* best-effort */ }
          };
          // [LESSONS-LEDGER] 内核反思产物 → 宪章教训账（只追加；来源标 kernel-shadow）。
          // 教训账写失败不影响内核；候选必须带证据锚点（kernel:<at>）。
          try {
            const lessonLedger = createLessonsLedger({ file: path.join(projectPath('data', 'state', 'mind'), LESSON_LEDGER_FILE) });
            const appendKernelEvent = shadowKernel.ports.events.append.bind(shadowKernel.ports.events);
            shadowKernel.ports.events.append = (row) => {
              try {
                if (row && row.type === 'lesson.formed') {
                  const rule = row.payload && typeof row.payload.text === 'string' ? row.payload.text : '';
                  if (rule) {
                    void lessonLedger.appendEvent(buildLessonCandidate({
                      rule, evidenceIds: [`kernel:${row.at}`], scope: ['global'], source: 'kernel-shadow', at: row.at,
                    }), { writer: 'kernel-shadow' }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/app.mjs:1474'));
                  }
                }
              } catch { /* 教训账失败不影响内核 */ }
              return appendKernelEvent(row);
            };
          } catch { /* best-effort */ }

          // [AUTHORITY] 启动即把双写字段摆出来；不假装已收敛。
          try {
            const authority = authorityReport();
            log(`[authority] 单写字段 ${authority.singleWriterFields} / 双写待收敛 ${authority.dualCount}（${authority.dual.join('/')}）`);
          } catch (error) { log('[authority] 报告失败（忽略）: ' + (error?.message ?? error)); }

          // [DUAL-READ/WRITE] 读以 hub 为准，tick 后的双写标量提案写回 hub（hub 仍是文件写者）。
          log('[kernel] 双写标量：读=state-hub（7 字段），写回=applyKernelProjection（hub 落盘）');

          // [LIFE-RECONCILE] 启动即对一次账：偏差数进日志，详情用 scripts/life-reconcile.mjs 随时可查。
          try {
            const reconcile = compareLifeStates(
              shadowKernel.state,
              mindStateHub && typeof mindStateHub.snapshot === 'function' ? mindStateHub.snapshot() : null,
            );
            log(`[kernel] 启动对账：可比 ${reconcile.checked} 项 / 超容忍 ${reconcile.drifted} / 缺失 ${reconcile.missing}`);
          } catch (error) { log('[kernel] 启动对账失败（忽略）: ' + (error?.message ?? error)); }
          log(`[kernel] 模式=${lifeMode}（独立状态文件 + 内存事件，不写既有状态${lifeMode === 'drive' ? '；真实端口尚未接好，本模式暂等同 shadow' : ''}）`);
        } catch (error) { log('[kernel] 影子内核初始化失败（忽略）: ' + (error?.message ?? error)); }
      }
      const lifeLoop = createLifeLoop({
        store: groundwork.store,
        hub: mindStateHub,
        lifeLog: groundwork.lifeLog,
        now: () => Date.now(),
        sleeping: () => life.get()?.state === 'sleep',
        log,
        onTick: shadowKernel ? ({ at }) => {
          const tr = shadowKernel.tick(at);
          if (typeof shadowTrace === 'function') shadowTrace(tr);
          // [G1] 影子内核每 tick 推进 active plan（若已挂载）；失败静默，绝不阻断主生命周期。
          // 注意：默认 logging 执行器不返回 done/total，plan 不会自终止——此开关仅用于验证内核闭环，生产须替换为真实 qq_* 执行器。
          if (planRunner && typeof planRunner.tick === 'function') {
            try { planRunner.tick(at).catch(() => {}); } catch { /* best-effort */ }
          }
        } : undefined,
      });
      lifeLoop.start();
      log('[life] 生命循环已启动（60s tick，1h 检查点）');
    } catch (error) {
      log('[life] 生命循环启动失败（忽略）: ' + (error?.message ?? error));
    }
    // [QUALITY-SHADOW] 每小时算一次社交质量信号（只读日志、只打日志，不参与决策）。
    try {
      const readJsonlRows = (file) => {
        try {
          return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { return []; }
      };
      const computeQualityShadow = () => {
        try {
          const metrics = classifyDirected(readJsonlRows(stateDataPath('floor-decisions.jsonl')), readJsonlRows(stateDataPath('action-log.jsonl')));
          const policy = decideQualityPolicy({ noTurnRate: metrics.noTurnRate, turnOtherRate: metrics.turnOtherRate, samples: metrics.directedWakes });
          log(`[quality] ${policy.level} scale=${policy.initiativeScale} 真漏接=${metrics.noTurnRate} 有意不回=${metrics.turnOtherRate} 样本=${metrics.directedWakes}`);
        } catch (error) { /* best-effort */ }
      };
      computeQualityShadow();
      const qualityTimer = setInterval(computeQualityShadow, 3600 * 1000);
      qualityTimer.unref?.();
    } catch (error) { /* best-effort */ }
    // [ALIVENESS-DAILY] 每天落一份 Aliveness 报告（只读派生；已有当天文件则跳过）。
    // 让“她活到什么程度”有连续趋势，而不是只有当前 7 天；6h 检查一次，跨天自然补齐。
    try {
      const alivenessDir = projectPath('data', 'reports', 'aliveness');
      const writeDailyAliveness = () => {
        try {
          const day = new Date().toLocaleDateString('sv-SE');
          if (fs.existsSync(path.join(alivenessDir, day + '.json'))) return;
          const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'aliveness-report.mjs'), '--write'], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref?.();
          log('[aliveness] 日报生成已触发（' + day + '）');
        } catch { /* 忽略 */ }
      };
      // [AUDIT-DAILY] 同一节拍顺带产出独立审计快照：完整性维不再恒为 no-data。
      // 只写结果、不改退出码判断（findings 仍由 CI 的 privacy-scan 门禁负责）。
      const writeDailyAudit = () => {
        try {
          const auditFile = projectPath('data', 'reports', 'security-audit.json');
          const child = spawn(process.execPath,
            [path.join(ROOT, 'scripts', 'privacy-scan.mjs'), '--out', auditFile],
            { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref?.();
        } catch { /* 忽略 */ }
      };
      writeDailyAliveness();
      writeDailyAudit();
      const alivenessTimer = setInterval(() => { writeDailyAliveness(); writeDailyAudit(); }, 6 * 3600 * 1000);
      alivenessTimer.unref?.();
    } catch { /* 忽略 */ }
  } catch (error) {
    log('[groundwork] 初始化失败（已忽略，不阻塞启动）: ' + (error?.message ?? error));
  }

  // [MIND-PROMPT] 会话 key → 信念库条目：private:<qq> 映射到 people[qq]，群映射到 groups[key]。
  // 之前 shadow 直接拿 key 去查 people，永远查不到（信念库按 QQ id 建）；这里统一映射。
  function mindBeliefFor(key) {
    const k = String(key || '');
    const b = mindGroundwork && mindGroundwork.beliefs;
    if (!b) return null;
    if (k.startsWith('private:')) return b.people[k.slice(8)] || null;
    return b.groups[k] || null;
  }

  // [SCHEMA] 数据层格式版本：启动时跑一次幂等迁移（先备份、原子替换；数据比代码新则拒绝）。
  // 只登记/补齐默认字段，不删不改旧值；失败不挡启动——数据兼容性不能拖垮 24/7 进程。
  try {
    const report = ensureSchemas({ log });
    if (report.changed.length || report.normalized.length) {
      log(`[schema] 迁移完成：升级 ${report.changed.join(',') || '无'}；首次登记 ${report.normalized.join(',') || '无'}`);
    }
    for (const w of report.warnings) log(`[schema] ⚠️ ${w}`);
  } catch (error) {
    log(`[schema] 迁移失败（已忽略，读取端仍按默认值兜）: ${error?.message ?? error}`);
  }

  // [SELF-EDIT-GUARD] 她改自己代码的护栏：src/*.js 改坏自动回滚（不自动重启）。
  // 由桥接拉起而不是另开计划任务——桥接重启守护跟着重启，跟着走不用两处维护。
  try {
    const guardPath = path.join(ROOT, 'scripts', 'self-edit-guard.mjs');
    if (fs.existsSync(guardPath)) {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [guardPath], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      log('[self-edit-guard] 已拉起护栏进程');
    }
  } catch (error) {
    log(`[self-edit-guard] 拉起失败（忽略）: ${error?.message ?? error}`);
  }

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangPolicyState = new Map();   // [SLANG-POLICY] key -> {lastAt,hourStart,hourCount}
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  // [VISION] 看图会话：走 DSH 的模型（和大脑同一条线路），不直连 DeepSeek。
  // 这样「DSH 里能用的模型，看图也一样能用」，不再需要单独的 PHONE_VISION_KEY。
  // [VISION-SERVICE] 会话/等待者/超时的状态机已抽到 src/vision-service.js，
  // bridge 只注入依赖（隔离会话、槽位、统一投递、collector），控制台视觉与表情打标共用一份。
  const vision = createVisionService({
    isReady: () => dshReady,
    ensureSession: (kind) => ensureIsolatedSession(kind),
    follow: (sessionId) => api.events.follow(sessionId),
    acquireSlot: (label, opts) => acquireTurnSlot(label, opts),
    bindGrant: (grant, sessionId) => bindTurnGrant(grant, sessionId),
    releaseGrant: (grant) => releaseTurnGrant(grant),
    submit: (req) => submitPromptWithTurnSlot(req),
    createCollector: () => createTurnCollector(),
    log: (line) => log(line),
  });
  // [GROUP-FACTS-LLM] 群事实抽取会话（每群 6h 一次，小 prompt，只要 JSON）
  const groupFactSessions = new Set();
  const groupFactCollectors = new Map();
  const groupFactWaiters = new Map();
  // [THOUGHTS] 独处/反思回合的输出捕获：结束后抽几句"念头"存下来
  const thoughtSessions = new Set();
  let lastThoughtTurn = null; // [REFLECT-DIAG] 上一轮反思/独处回合的结果（失败原因靠它，不靠猜）
  const thoughtCollectors = new Map();
  // [TASK-LEDGER] 任务会话捕获：turn 结束后回写任务台账
  const taskSessions = new Set();
  const taskCollectors = new Map();
  // [DEDUP] 会话最近一次任务交付时间：主会话的 replyCheck 跳过，避免重复说同一件事
  const recentTaskReportAt = new Map();
  // [SEEN] 无 key 会话（own-life/任务/学习）里的浏览工具：同样记进冲浪记录
  const noKeyToolNames = new Map();
  // [SEEN] 有 key 会话本回合看到的内容头（喂给 intake 提炼）
  const turnSeenHeads = new Map();
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // 表情包库（加载/同步/发送/备注/收藏）已搬到 sticker-service.mjs（P3-RW-4）。
  const stickerService = createStickerService({
    cfg,
    getBot: () => bot,
    log,
    stickerFile: STICKER_FILE,
    loadStickerStore,
    saveStickerStore,
    mergeStickerLibrary,
    findSticker,
    markStickerUsed,
    applyStickerNote,
    captureSendGuard,
    safeFetchBuffer,
    getOutgoing: () => outgoing,
    sleep,
    randInt,
    fetch,
    oneBotError,
    getSocialV2State,
    fetchOneBotImage,
    fetchFaceMedia,
  });
  const {
    stickerEnabled,
    saveStickerStoreSafe,
    syncStickerLibrary,
    getStickerImageData,
    sendStickerV2,
    applyStickerNoteV2,
    setStickerRemarkV2,
    collectStickerV2,
  } = stickerService;

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  // 语音发送（配置/路径解析/限流/发送/回读）已搬到 voice-service.mjs（P3-RW-1）。
  // 队列在 main 后段才创建，所以用 getter 延迟取；其余依赖都是函数声明或稳定对象。
  const voiceService = createVoiceService({
    cfg,
    root: ROOT,
    fetch,
    processAudioVolume,
    cleanupTemp,
    log,
    appendActivity,
    shouldAuditKey,
    knownAgentTokens: KNOWN_AGENT_TOKENS,
    assertOutboundAuditOk,
    captureSendGuard,
    getOutgoing: () => outgoing,
    oneBotError,
    getSocialV2State,
    saveSocialV2State,
    truncateText,
  });
  const {
    voiceCfg,
    voiceLibrary,
    voicePathInsideLibrary,
    resolveVoicePathForV2,
    resolveVoicePathForOperator,
    voiceBudgetCheck,
    voiceBudgetCommit,
    sendVoiceV2,
    recordVoiceSentV2,
    verifyVoiceMessageSent,
    sendVoiceForV2,
  } = voiceService;

  // [IMAGEGEN] 生图后端：进程不常驻，谁要图谁把它拉起来（见 src/inori-imagegen.js）。
  // 这里只建管理器；真正的 spawn / 空闲关闭都在模块里，桥接重启不会留下孤儿进程
  //（进程是桥接的子进程，桥接一退就跟着退了）。
  // rootDir 必须是**仓库根目录**：配置里的 tools/sd-vulkan、tools/sd-models 都相对它。
  //（第一版误传了 ROOT=qq-bridge，路径指进 qq-bridge/tools/，status 里 binExists=false 露出来的。）
  const imagegen = createImageGen({ rootDir: projectPath(), cfg: cfg.imagegen ?? {}, log });

  // 生图（按需拉起/落盘/发送）已搬到 image-service.mjs（P3-RW-3）。
  const imageService = createImageService({
    cfg,
    captureSendGuard,
    getOutgoing: () => outgoing,
    sleep,
    randInt,
    fetch,
    oneBotError,
    imagegen,
    freeMemMB,
    projectPath,
    stateDataPath,
  });
  const { imagePaths, sendImageV2, sendImageFileV2, imageForV2, imageStatusV2, imageStopV2 } = imageService;

  // 黑话库落盘已搬到 slang-store-service.mjs（P3-RW-61）。
  const slangStoreSvc = createSlangStore({
    log,
    logAction,
    saveSlang,
    SLANG_FILE,
    SLANG_MAX_ENTRIES,
    getSlangEntries: () => slangEntries,
    setSlangEntries: (v) => { slangEntries = v; },
    getSlangStoreWritable: () => slangStoreWritable,
  });
  function saveSlangStore() { return slangStoreSvc.saveSlangStore(); }


  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  function ensureSlangLearnerSession() { return slangSessionLifecycle.ensureSlangLearnerSession(); }

  // 黑话学习者会话失效已搬到 slang-session-lifecycle.mjs（P3-RW-63）。
  const slangSessionLifecycle = createSlangSessionLifecycle({
    log,
    fs,
    cfg,
    STATE_DIR,
    SLANG_SESSION_FILE,
    learnerSessions,
    learnerWaiters,
    learnerCollectors,
    getApi: () => api,
    getSlangLearnerSessionId: () => slangLearnerSessionId,
    getResolvePresetName: (name, opts) => resolvePresetName(name, opts),
    ensureHerWorkspace,
    ensureChatModel,
    unwrap,
    readJsonSafe,
    atomicWriteJson,
    recordSessionKind,
    setSlangLearnerSessionId: (v) => { slangLearnerSessionId = v; },
  });
  function invalidateSlangLearnerSession() { return slangSessionLifecycle.invalidateSlangLearnerSession(); }



  // ── [ISOLATED] 自主任务的独立会话（own-life / 夜间反思）────────────────────
  // 实测 DSH 单实例支持跨会话并发（两个 session 的 turn 可同时 start/end），
  // 所以「她干别的事时不回消息」的瓶颈不是 DSH，而是自主任务占用了私聊会话。
  // 把这些任务挪到独立会话后，私聊/群聊各自独立，互不排队。
  // 注意：这些会话在 pumpMux 里没有 reverse 映射，事件会被静默跳过（不会往 QQ 发）。
  const isolatedSessions = new Map(); // kind -> sessionId
  // [ISOLATED-REVIVE] 会话被归档后的自愈：blocked 只说明"这个会话废了"，重建即可
  // 持久化：重启后仍记得哪些会话已归档，别再把内容投进死会话
  const ISOLATED_DEAD_FILE = path.join(STATE_DIR, 'isolated-dead.json');
  const loadIsolatedDead = () => { try { const a = JSON.parse(fs.readFileSync(ISOLATED_DEAD_FILE, 'utf8')); return new Set(Array.isArray(a) ? a.map(String) : []); } catch { return new Set(); } };
  const saveIsolatedDead = () => { try { fs.mkdirSync(STATE_DIR, { recursive: true }); atomicWriteJson(ISOLATED_DEAD_FILE, [...isolatedDead]); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:2915'); } };
  const isolatedDead = loadIsolatedDead();  // kind：最近一次 turn 被 blocked（=已归档）
  const isolatedKindBySession = new Map(); // sessionId -> kind（blocked 时反查是哪种会话挂了）
  const isolatedStatePath = (kind) => path.join(STATE_DIR, `isolated-${kind}.json`);
  // [TRANSIENT-ARCHIVE] 临时会话（隔离/黑话学习）闲置后自动归档；主聊天会话不动。
  const transientArchiveTimers = new Map();
  const TRANSIENT_IDLE_MS = 5 * 60 * 1000;
  const HER_WORKSPACE_DIR = String(cfg.sessionCwd || '').trim() || path.join(STATE_DIR, 'agents');
  // 临时会话归档/清理/工作区已搬到 transient-session-service.mjs（P3-RW-47）。
  const transientSession = createTransientSession({
    // [WIRING-FIX] 归档反查表 / 空闲超时 / 已死标记 / gate preset 列表注入（原来裸引用）
    isolatedKindBySession,
    isolatedDead,
    TRANSIENT_IDLE_MS,
    getDshPresetIds: () => dshPresetIds,
    fs,
    path,
    log,
    cfg,
    STATE_DIR,
    STATE_DATA_DIR,
    atomicWriteJson,
    unwrap,
    ensureChatModel,
    isolatedPresetFor,
    isolatedStatePath,
    loadBrowse,
    loadWorks,
    recordSessionKind,
    saveIsolatedDead,
    saveState,
    isolatedSessions,
    transientArchiveTimers,
    sessionKinds: getSessionKinds(),
    state,
    getSocialV2: () => socialV2,
    getApi: () => api,
    getDshReady: () => dshReady,
    // [WIRING-FIX] transient 服务里还在用这几个 main() 变量
    learnerSessions, SLANG_SESSION_FILE,
    getSlangLearnerSessionId: () => slangLearnerSessionId,
    setSlangLearnerSessionId: (v) => { slangLearnerSessionId = v; },
    getCfgRef: () => cfgRef,
  });
  function readTransientArchives() { return transientSession.readTransientArchives(); }
  function writeTransientArchives(list) { return transientSession.writeTransientArchives(list); }
  function noteTransientArchive(a, b, c) { return transientSession.noteTransientArchive(a, b, c); }
  function dropTransientArchive(sid) { return transientSession.dropTransientArchive(sid); }
  function archiveTransientNow(a, b) { return transientSession.archiveTransientNow(a, b); }
  function cancelTransientArchive(sid) { return transientSession.cancelTransientArchive(sid); }
  function scheduleTransientArchiveAt(a, b, c) { return transientSession.scheduleTransientArchiveAt(a, b, c); }
  function scheduleTransientArchive(a, b) { return transientSession.scheduleTransientArchive(a, b); }
  function restoreTransientArchives() { return transientSession.restoreTransientArchives(); }
  function pruneMissingSessions() { return transientSession.pruneMissingSessions(); }
  function ensureHerWorkspace() { return transientSession.ensureHerWorkspace(); }
  function ensureIsolatedSession(a, b) { return transientSession.ensureIsolatedSession(a, b); }

  // [BROWSE-LEARN] 最近逛到的正文窗口：抽高频词喂词库（她之后自己 confirm/reject）
  const browseLearnWindow = [];
  const TASK_POOL_FILE = path.join(STATE_DIR, 'task-pool.json');
  // [WORKS] 分身工作台：一件活一个记录，执行复用任务池（一个任务一个会话）。
  // 主体性纪律：进度回她、结果回她；分身不另起人格、不写私聊原文。
  const WORKS_FILE = path.join(STATE_DATA_DIR, 'works.json');
  let worksStore = loadWorks(WORKS_FILE);
  // [BROWSE] 她的冲浪记录：上网看过什么（确定性记录；own-life 前沉淀成一条 browse 记忆）
  const BROWSE_FILE = path.join(STATE_DATA_DIR, 'browse-log.json');
  let browseStore = loadBrowse(BROWSE_FILE);

  function browseSave() { saveBrowse(BROWSE_FILE, browseStore); }
  // [TOOL-ERR] 工具错误可读化：错误对象/String(object) 都要变成人能读的句子（之前全是 "[object Object]"）
  function errToText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v === '[object Object]' ? '[错误对象未序列化]' : v;
    if (v instanceof Error) return v.message || String(v);
    if (typeof v === 'object') {
      try { return v.message || v.error || JSON.stringify(v).slice(0, 400); } catch { return '[不可序列化错误]'; }
    }
    return String(v);
  }
  // [MEMORY-EDIT] 条目指纹：给 memory_list 返回 h，memory_edit 可带 hashes 校验"改之前是不是这条"
  function textHash(s) {
    let h = 5381;
    for (const ch of String(s ?? '')) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    return h.toString(36);
  }
  // [LESSON-EFFECT] 经验效果代理指标：注入过的经验 → 本回合结果（completed/cancelled…）记到 lesson-usage.jsonl
  // 这不是因果证明，只是可机检的观察数据（哪条经验被用过的回合完成率更高）。
  const lessonPendingByKey = new Map();
  // 冲浪沉淀已搬到 browse-service.mjs（P3-RW-56）。
  const browseService = createBrowseService({
    log,
    getBrowseStore: () => browseStore,
    setBrowseStore: (v) => { browseStore = v; },
    browseSave,
    pendingBrowse,
    hasContent,
    markBrowseOutcome,
    renderBrowseDigest,
    loadEntries,
    MEMORY_FILE: MEM_DIR + '/memory.jsonl',
    appendJsonl,
  });
  function sedimentBrowseIfAny() { return browseService.sedimentBrowseIfAny(); }

  // 投递到独立会话：带完整唤醒上下文（角色/令牌/记忆/表情），再接任务文本。
  // ★ 修掉一个连带 bug：以前 deliverPrompt 传 wakeReason 会用 buildWakePromptV2
  //   重建 prompt，把 own-life 辛苦拼的 autonomy/关系/gloss 文本覆盖掉。

  // [GATE] 并发闸门：同时最多 N 个 turn（所有会话合计），防止多会话并发撞 API 限流。
  // 满员时排队（最多 20 秒），超时放行并记日志——不阻塞消息，也不丢消息。
  // [TURN-DISPATCH] 排队 / 令牌租约 / 活跃回合 / 同会话串行都在 src/turn-dispatch.js（有单测锁）。
  // [P2-1/P2-2] 调度治理：后台小时预算 + 优先级分层 + 资源门（默认只观察）。
  const resourceGate = createResourceGate({
    enabled: cfgRef?.resources?.enabled !== false,
    observeOnly: cfgRef?.resources?.observeOnly !== false,
    minFreeMemMB: Number(cfgRef?.resources?.minFreeMemMB ?? 1536),
    maxCpuPercent: Number(cfgRef?.resources?.maxCpuPercent ?? 80),
    lowKinds: cfgRef?.turnPriority?.lowKinds ?? ['intake', 'slang', 'groupfact'],
    sampleMs: Number(cfgRef?.resources?.sampleMs ?? 30000),
    log: (line) => log(line),
  });
  // [DISK-GUARD] 磁盘维度的资源门：只采样 C 盘可用与 %TEMP%\dsh-workspace-changes-*
  // 快照总量，默认 observeOnly（只记日志）；cleanup=true 且 observeOnly=false 才清过期目录。
  // 不参与任何说话/记忆/人格判断，保证现有行为不变。
  const diskGuard = createDiskGuard({
    enabled: cfgRef?.resources?.disk?.enabled !== false,
    observeOnly: cfgRef?.resources?.disk?.observeOnly !== false,
    cleanup: cfgRef?.resources?.disk?.cleanup === true,
    sampleMs: Number(cfgRef?.resources?.disk?.sampleMs ?? 600000),
    minFreeGB: Number(cfgRef?.resources?.disk?.minFreeGB ?? 20),
    maxSnapshotGB: Number(cfgRef?.resources?.disk?.maxSnapshotGB ?? 12),
    maxAgeHours: Number(cfgRef?.resources?.disk?.maxAgeHours ?? 12),
    log: (line) => log(line),
  });
  diskGuard.start();
  // [P2-2] 后台按 kind 分层：gate/vision 高（门判定与看图等不得）、intake/slang/groupfact 低。
  function turnPriorityFor(kind, label) {
    if (kind === 'chat') return String(label).startsWith('private:') ? 100 : 60;
    const kindName = String(label).replace(/^isolated:/, '').replace(/[:#].*$/, '');
    const tp = cfgRef?.turnPriority ?? {};
    const highKinds = Array.isArray(tp.highKinds) ? tp.highKinds : ['gate', 'vision'];
    const lowKinds = Array.isArray(tp.lowKinds) ? tp.lowKinds : ['intake', 'slang', 'groupfact'];
    if (highKinds.includes(kindName)) return Number(tp.high ?? 40);
    if (lowKinds.includes(kindName)) return Number(tp.low ?? 10);
    return Number(tp.normal ?? 20);
  }
  function recordSchedulerDrop(reason, info = {}) {
    try {
      fs.appendFileSync(BACKGROUND_DROPS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), reason, ...info })}\n`, 'utf8');
    } catch (error) {
      log('调度记账失败（不影响调度）', error?.message ?? error);
    }
  }
  const turnDispatch = createTurnDispatch({
    maxConcurrent: () => Math.max(1, Number(cfgRef?.dsh?.maxConcurrentTurns ?? 3)),
    reserveForChat: () => {
      const max = Math.max(1, Number(cfgRef?.dsh?.maxConcurrentTurns ?? 3));
      return Math.max(0, Math.min(max - 1, Number(cfgRef?.dsh?.turnReserveForChat ?? 2)));
    },
    log: (line) => log(line),
    plan: planTurnGrants,
    // [P2-1] 后台小时预算（maxPerHour<=0 关闭）；超额排队，排队超时丢弃并记账。
    // gate 是聊天路径的前置（群消息要不要回），必须豁免——否则预算满时群里会没人回话。
    budget: () => ({
      maxPerHour: Number(cfgRef?.background?.maxPerHour ?? 6),
      windowMs: Number(cfgRef?.background?.windowMs ?? 60 * 60 * 1000),
      queueTimeoutMs: Number(cfgRef?.background?.queueTimeoutMs ?? 120000),
      // [LIFE-EXEMPT] 她自己的生命节律（ownlife 1/h、reflect 1/夜、diary 1/天）不该被
      // 小时预算饿死；频率本身有上限，不会被这个豁免放大。
      exemptKinds: cfgRef?.background?.exemptKinds ?? ['gate', 'ownlife', 'reflect', 'diary'],
    }),
    // [P2-2] 资源紧张时低优先级后台让路（observeOnly 时门内只记日志，不挡）。
    shouldHold: (waiter) => resourceGate.shouldHold(waiter),
    priorityOf: (kind, label) => turnPriorityFor(kind, label),
    onDrop: (info) => recordSchedulerDrop('hourly_budget', info),
  });
  function maxConcurrentTurns() { return turnDispatch.max(); }
  // [DEAD-CODE] 2026-11-03 删掉 `pumpTurnSlots`：turnDispatch.pump 只在 ttlTimer 后续调用，零引用。
  // [P2-3] token 日预算：超额只放聊天，后台一律拒绝（由 turn-prompt 当成投递失败）。
  function tokenCapState() {
    const cap = Math.max(0, Number(cfgRef?.tokenLedger?.dailyCapCny ?? 0));
    if (!(cap > 0)) return { spent: 0, cap: 0 };
    try { return { spent: tokenLedger.todayTotals().cost, cap }; } catch { return { spent: 0, cap }; }
  }
  const acquireTurnSlot = (label = '', opts = {}) => {
    const kind = opts.kind
      || (String(label).startsWith('private:') || String(label).startsWith('group:') ? 'chat' : 'background');
    // [P2-3] gate 豁免日闸：它是组聊唤醒的前置，卡住 gate 等于卡住聊天本身。
    const capExempt = kind === 'background'
      && (cfgRef?.tokenLedger?.capExemptKinds ?? ['gate']).includes(kindOfLabel(label));
    if (!capExempt) {
      const capState = tokenCapState();
      const verdict = evaluateDailyCap({ spent: capState.spent, cap: capState.cap, kind });
      if (!verdict.allowed) {
        log(`[token-cap] 今日已花 ¥${verdict.spent.toFixed(2)} 达到上限 ¥${verdict.cap}，拒绝后台任务 ${label}`);
        recordSchedulerDrop('token_daily_cap', {
          label,
          kind,
          spent: Math.round(verdict.spent * 100) / 100,
          cap: verdict.cap,
        });
        return Promise.resolve({ ok: false, rejected: true, reason: 'token_daily_cap', label, kind });
      }
    }
    return turnDispatch.acquire(label, opts);
  };
  const bindTurnGrant = (grant, sessionId) => turnDispatch.bind(grant, sessionId);
  const releaseTurnGrant = (grant) => turnDispatch.release(grant);
  // turn/start：把「已发槽」转成「活跃回合」并记下 label（同会话串行）
  function consumeTurnGrant(sessionId) { return turnDispatch.begin(sessionId); }

  /**
   * 唯一的 DSH prompt 提交入口：统一管理 grant 的申请、会话绑定和失败释放。
   * 正常模型回合由 turn/start 消费 grant；直接命令没有 turn/start，必须在这里释放。
   */
  async function submitPromptWithTurnSlot({ sessionId, label, kind = 'background', content, useSlot = true, turnGrant = null }) {
    return submitTurnPrompt({
      sessionId,
      label,
      kind,
      content,
      useSlot,
      turnGrant,
      acquireTurnSlot,
      bindTurnGrant,
      releaseTurnGrant,
      prompt: (request) => api.sessions.prompt(request),
    });
  }

  // [SCHED] 原「后台让路」已由并发调度接管：对话有预留份额（turnReserveForChat），后台照常跑，不再空等。
  // 需要恢复旧行为时把 config 的 dsh.schedulerYield 设成 true。
  async function yieldToConversations(kind) {
    try { if (cfgRef?.dsh?.schedulerYield !== true) return; } catch { return; }
    if (kind === 'gate') return; // 门判定是群唤醒的前置，很快，不让
    const t0 = Date.now();
    while (pendingWakeKeys.size > 0 && Date.now() - t0 < 15000) await sleep(300);
  }

  // 只读群窗（readToken/groupReadWindowText）已搬到 group-window.mjs（P3-RW-12）。
  const groupWindow = createGroupWindow({
    getSocialV2State,
    saveSocialV2State,
    getSocialV2: () => socialV2,
    isSessionAllowedInCurrentMode: (k) => isSessionAllowedInCurrentMode(k),
  });
  const { readTokenFor, readTokenOkMain, groupReadWindowText } = groupWindow;


  // [ISOLATED-CONTEXT] 后台隔离会话（ownlife/reflect/diary/intake）只看背景，不拿会话令牌、不拿消息快照。
  // 以前这里拼的是 buildWakePromptV2(ownerKey)：等于把主人私聊的令牌+上下文塞进她的"自由时间"会话，
  // 她会在独处时顺手往私聊发一句（2026-10-28 00:59 实证：ownlife 往主人私聊发了「困。都快一点了」）。
  // 现在只给：角色卡 + 手头会话（只有名字/未读，无令牌）+ 一句"这是背景不是催你回话"。
  // 隔离会话投递与日记已搬到 isolated-session-service.mjs（P3-RW-46）。
  const isolatedSession = createIsolatedSession({
    cfg,
    log,
    // [WIRING-FIX] 日记上下文拼路径要用 path
    path,
    getSocialV2: () => socialV2,
    getSocialV2State,
    readRoleState,
    roleHintForMode,
    getIsSessionAllowedInCurrentMode: () => isSessionAllowedInCurrentMode,
    renderConversations,
    getDshReady: () => dshReady,
    yieldToConversations,
    isolatedDead,
    ensureIsolatedSession,
    ensureChatModel,
    buildWakePromptV2,
    stripKnownTokens,
    collectSessionTokens,
    promptTextOf,
    buildContextPacket,
    groupReadWindowText,
    // [WIRING-FIX] 消费方传的是 {withTraces, key}；之前这里返回“函数本身”，
    // 结果整个自查函数的源码被拼进 ownlife prompt（实测 7 次，约数千 token），真正的自我认知从未注入。
    getSelfKnowledgeBlock: (opts) => selfKnowledgeBlock(opts),
    acquireTurnSlot,
    bindTurnGrant,
    submitPromptWithTurnSlot,
    getApi: () => api,
    thoughtSessions,
    thoughtCollectors,
    taskSessions,
    taskCollectors,
    stateWithKey,
    saveSocialV2State,
    getLifeState,
    todayDiaryWritten,
    diaryAttempts,
    bumpDiaryAttempts,
    logAction,
    readJsonlSafe,
    MEM_DIR,
    stateDataPath,
    renderReflectLine,
    loadLessons,
    loadGoals,
    diarySessions,
    createTurnCollector,
  });
  function buildIsolatedContextV2(key) { return isolatedSession.buildIsolatedContextV2(key); }
  function deliverToIsolated(a, b, c) { return isolatedSession.deliverToIsolated(a, b, c); }
  function startDiarySession(a, b) { return isolatedSession.startDiarySession(a, b); }
  // [WIRING-FIX] consoleDeps.diaryForcedDays 的 getter 需要这个名字在作用域里存在（mux-bus 重试日记要用）
  const diaryForcedDays = isolatedSession.diaryForcedDays;

  // 黑话抽取/研究执行已搬到 slang-learner-runtime.mjs（P3-RW-52）。
  const slangLearnerRuntime = createSlangLearnerRuntime({
    cfg,
    log,
    getSlangEntries: () => slangEntries,
    setSlangEntries: (v) => { slangEntries = v; },
    // [WIRING-FIX] 抽取回合要用的 main() 局部状态显式注入
    learnerWaiters,
    slangWindows,
    slangResearchingIds,
    getDshReady: () => dshReady,
    ensureSlangLearnerSession,
    invalidateSlangLearnerSession,
    queueSlangTask,
    saveSlangStore,
    buildExtractionPrompt,
    parseExtractionJson,
    upsertSlangEntry,
    autoPromoteSlang,
    buildResearchPrompt,
    parseResearchJson,
    submitPromptWithTurnSlot,
  });
  function waitLearnerTurn(a, b) { return slangLearnerRuntime.waitLearnerTurn(a, b); }
  function runSlangExtraction(a, b) { return slangLearnerRuntime.runSlangExtraction(a, b); }
  function runSlangResearch(a) { return slangLearnerRuntime.runSlangResearch(a); }

  const slangContext = createSlangContext({
    cfg,
    getSlangEntries: () => slangEntries,
    slangWindows,
    // [WIRING-FIX] 策略/冷却/限频容器与就绪态注入（原来裸引用，黑话提取排队每次都炸）
    slangPolicyState,
    slangExtractionCooldowns,
    slangSubmitTimes,
    getDshReady: () => dshReady,
    log,
    truncateText,
    renderTimeLine,
    queueSlangTask,
    decideSlangExtraction,
    hasUrgentSignal,
    runSlangExtraction,
    buildSlangContext,
  });
  function maybeQueueSlangExtraction(key) { return slangContext.maybeQueueSlangExtraction(key); }
  function feedSlangWindow(a, b, c) { return slangContext.feedSlangWindow(a, b, c); }
  function allowSlangSubmit(key) { return slangContext.allowSlangSubmit(key); }
  function publicSlangEntry(e) { return slangContext.publicSlangEntry(e); }
  function confirmedSlangListV2() { return slangContext.confirmedSlangListV2(); }
  function withSlangContext(promptText) { return slangContext.withSlangContext(promptText); }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }

  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // [TASK-SERVICE] 任务池/工作台状态机已抽到 runtime-tasks.mjs；这里只做注入和别名。
  const taskService = createTaskService({
    api, cfgRef, log, isDshReady: () => dshReady, STATE_DIR, STATE_DATA_DIR, worksStore,
    ensureHerWorkspace, ensureChatModel, recordSessionKind,
    getSocialV2State, saveSocialV2State, scheduleWakeV2, recentTaskReportAt,
    taskSessions, taskCollectors, unwrap, buildWakePromptV2, rememberAgentToken, submitPromptWithTurnSlot,
  });
  const {
    running: taskPoolRunning, worksSave, workByTaskId, updateWorkById, buildWorkPromptText,
    reconcileWorksOnBoot, startWork, poolSave, createTaskSession, buildTaskPromptText, deliverTaskPrompt,
    takeTaskSkillIds, dispatchQueuedTask, pickNextTaskRow, drainTaskPool, retireTaskSession,
    taskPoolWatchdog, migrateTaskPoolOnce, notifyTaskDone, taskBoardSnapshot,
  } = taskService;



  // [GATE-SERVICE] 注意门运行态已抽到 runtime-gate.mjs；纯判定仍在 inori-gate.js。
  const gateService = createGateService({
    cfgRef, log, api, STATE_DIR, getSocialV2State, saveSocialV2State,
    getSelfNickname: () => selfNickname, readRoleState, scheduleWakeV2,
    getSocialV2Map: () => socialV2, local3bAlive, completeLocal3b, deliverToIsolated,
    isolatedSessions, claimEmbedSpawn, resetClaim: () => { embedSpawnClaimAt = 0; }, sleep,
    // [C1] 门的内在偏置：SelfState + 该群的信念；失败返回 0 偏置。
    getMindBias: (groupKey) => {
      try {
        return computeAttentionBias({
          self: mindGroundwork ? mindGroundwork.selfState : null,
          belief: mindBeliefFor(groupKey),
          scene: 'group',
        });
      } catch { return { bias: 0, reasons: [] }; }
    },
  });
  const {
    gateEmbedBase, gateEmbedAlive, gateEmbedStart, gateEmbedTexts, gateAnchors, gateAgentName,
    markGateSeen, appendGateLog, applyGateHits, loadGateSensOverride, gateLoopTick,
    gateSessions, gateCollectors, gateBatches,
  } = gateService;


  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();

  // 模型目录已搬到 model-catalog-service.mjs（P3-RW-53）。
  const modelCatalog = createModelCatalog({
    cfg,
    log,
    api,
    state,
    TOKEN_USAGE_FILE,
    createTurnCollector,
    createSessionTelemetry,
    createTokenLedger,
    resolvePriceTable,
  });
  function fetchModelCatalog() { return modelCatalog.fetchModelCatalog(); }

  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, Math.max(60000, Number(cfg.socialV2?.wake?.pendingLeaseMs) || 3 * 60 * 1000)); // 原来 30 分钟太长：卡死后半小时内所有唤醒都被判忙
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;  let dshDownAt = 0; // [STALE-TURN] DSH 不可用的起点，用于区分「真重启」与「探测抖动」
  let firstReadyRecovered = false; // [STALE-TURN] 首次就绪只做一次启动补偿
  let dshCheckStarted = false;
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // AI 强制刷新表情库的最小间隔时间戳：console-server 经 deps facade 读写它。
  // [WIRING-FIX] 2026-11-03：facade 的 get/set 引用了这个标识符，但它在全文件从未声明
  // （sticker-service.mjs:62 的是工厂内局部变量，不在 facade 作用域）⇒ 每次读都 ReferenceError，
  // 10 秒防抖实际上不存在。此声明补上接线；行为守卫见 test/test-app-facade-wiring.test.mjs。
  let lastForcedAgentStickerSync = 0;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  // 模式/preset 刷新已搬到 mode-refresh-service.mjs（P3-RW-58）。
  const modeRefresh = createModeRefresh({
    api,
    unwrap,
    cfg,
    log,
    STATE_DIR,
    readJsonSafe,
    normalizeModeInput,
    normalizeOwnerQQ,
    setCurrentMode: (v) => { currentMode = v; },
    getDshDefaultPreset: () => dshDefaultPreset,
    setDshDefaultPreset: (v) => { dshDefaultPreset = v; },
    setClosedAgentPreset: (v) => { closedAgentPreset = v; },
    setDshPresetIds: (v) => { dshPresetIds = v; },
  });
  function refreshMode() { return modeRefresh.refreshMode(); }
  function refreshPresetList() { return modeRefresh.refreshPresetList(); }

  // 会话策略（模式/白名单/preset/owner lane）已搬到 session-policy.mjs（P3-RW-9）。
  const OWNER_LANE_SUFFIX = '#owner';
  const sessionPolicySvc = createSessionPolicy({
    getCfg: () => cfg,
    getCurrentMode: () => currentMode,
    getDshPresetIds: () => dshPresetIds,
    getDshDefaultPreset: () => dshDefaultPreset,
    getClosedAgentPreset: () => closedAgentPreset,
    allowed,
    getSocialV2State,
    state,
    log,
  });
  const {
    modeAllowed,
    resolvePresetName,
    laneBaseKey,
    isOwnerLaneKey,
    ownerLaneFor,
    modePreset,
    isSessionAllowedInCurrentMode,
    sessionPolicy,
    isCurrentSession,
  } = sessionPolicySvc;


  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  // 会话退役（停工作/清缓存/撤销映射/策略对账）已搬到 session-retire.mjs（P3-RW-10）。
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // [OWNLIFE-RETRY] 所有会话（含隔离会话）的 turn/start 时间：用来判断「投递了但一直没开始回合」
  const lastTurnStartAt = new Map();
  const noteTurnStart = (sessionId) => {
    try {
      const sid = String(sessionId ?? '');
      if (!sid) return;
      lastTurnStartAt.set(sid, Date.now());
      if (lastTurnStartAt.size > 200) {
        const oldest = [...lastTurnStartAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 50);
        for (const [k] of oldest) lastTurnStartAt.delete(k);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:3919'); }
  };
  const busySinceMs = new Map(); // key -> 本次 busy 开始时间（[BUSY-CAP] 硬上限计时）
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const toolCallArgs = new Map(); // sessionId -> Map<callId, rawArgs>：[BROWSE] 记录她浏览时查了什么
const turnToolStats = new Map(); // sessionId -> {ok, fail, names}：一回合工具成败（喂 [TOOL-LEARN]）
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // [WAIT-HOLD] 正在跑的 qq_wait_for_messages：等消息是她做正事（合批/收尾观察），
  // 不能算进 turnMaxMs 的「霸占会话」里——否则等 60s、45s 就被掐，永远发不出一句话。
  const waitToolCalls = new Map(); // sessionId -> Set<callId>：在跑的等待调用
  const waitStartAt = new Map(); // sessionId -> 本段等待开始时间
  const turnWaitMs = new Map(); // sessionId -> 本回合累计等待毫秒
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  // [WAIT-LEASE-FIX] 原来 15 分钟：一次等待被客户端掐断后，这个会话会被"自己的等待"锁住十几分钟，
  // 期间她所有 qq_wait_for_messages 都 429（实测报"最早约 841 秒后可再等"），表现就是"人卡住了"。
  // 服务端单次等待最多 timeoutMs(≤180s) + 静默窗(≤120s) + 5s ≈ 5 分钟，租约 4 分钟足够兜住残留。
  const ACTIVE_WAIT_LEASE_MS = 4 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  // [OWNER-LANE-FIX] reverse 必须存 base key：owner lane 事件流若带着 #owner 回来，getSocialV2State 会拒绝并打断整条事件流
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, String(key).endsWith('#owner') ? String(key).slice(0, -'#owner'.length) : key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  // 会话遥测（模型选择/token 账本/in-flight 重建）已搬到 session-telemetry.mjs（P3-RW-8）。
  const sessionTelemetry = createSessionTelemetry({
    cfg,
    log,
    tokenLedger,
    createTurnCollector,
    collectors,
    v2TurnStartAt,
    api,
    // [RECOVERED-GRANT] 恢复进行中回合时视为 turn/start 已发生，消费槽令牌
    onTurnRecovered: (sid) => { try { consumeTurnGrant(sid); } catch { /* 忽略 */ } },
  });
  const { rememberModel, recordSessionUsage, recordSessionSnapshot, rebuildInFlightCollector } = sessionTelemetry;


  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  const sessionRetire = createSessionRetire({
    api, log, state, saveState, getOutgoing: () => outgoing,
    activeWaits, queuedHintAt, slangSubmitTimes, feedbackTimes,
    wakeConfigMissCount, wakeConfigUpdatedKeys, markReadCalledKeys,
    sessionTelemetry, reverse, collectors,
    getModelAppliedSessions: () => modelAppliedSessions,
    sendToolSucceededSessions, pendingSendToolCalls,
    waitToolCalls, waitStartAt, turnWaitMs, v2TurnStartAt, toolCallNames,
    getSocial: () => social, getSocialV2: () => socialV2, getPending: () => pending, cancelPendingEntry,
    clearSocialV2Timers, cancelSocialTimers, disarmPendingWakeLease, pendingWakeKeys,
    rememberAgentToken, saveSocialV2State, isCurrentSession, isOwnerLaneKey,
    getDshPresetIds: () => dshPresetIds,
  });
  const { stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies } = sessionRetire;


  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
    // [M4] 跨会话补投并行：每个会话一个任务单元（内部仍按 items 顺序投递，保 turn 顺序），
    // 会话间并发推进；单会话补投异常由 runParallel 隔离，不影响其他会话继续补投。
    await runParallel(entries.map(([key, items]) => ({
      id: key,
      run: async () => {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
            // [FAREWELL-CLOSE] 退场发言补投真正成功后才归位状态机（DSH 未就绪时入队不算）。
            if (item.farewell && result.queued !== true && result.retried !== true && result.skipped !== true) {
              try { socialLoop.settleFarewell(key); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:settleFarewell'); }
            }
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      },
    })));
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:4493'); }
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:4498'); }
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        // [STALE-TURN] DSH 一重启，任何"进行中"的回合按定义都已死掉 ——
        // 但作者只补投了队列，没有清理 collectors / v2TurnStartAt / pendingWakeKeys，
        // 于是 isConversationBusyV2 永远为 true：新消息只进队列，永远等不到 turn/end。
        // （2026-10-23 14:16 事故就是这么来的：唤醒已投递 → DSH 挂掉 → 恢复后她再不说话。）
        try {
          const nCollectors = collectors.size;
          const nTurnStart = v2TurnStartAt.size;
          const nPendingWake = pendingWakeKeys.size;
          const staleTurns = nCollectors + nTurnStart + nPendingWake;
          const downMs = dshDownAt ? Date.now() - dshDownAt : 0;
          // 只有真正停了 ≥30 秒才清；短暂探测抖动时回合可能仍在跑，清了会丢回复。
          // [PROBE-JITTER] 旧值是 3000（与注释差 10 倍）：一次 5s 的 settings.describe 超时
          // 就会把正在跑的回合标记全清掉，turn/end 到来时 collector 已没了 → 回复静默丢失。
          if (staleTurns > 0 && downMs >= 30_000) {
            collectors.clear();
            v2TurnStartAt.clear();
            busySinceMs.clear();
            pendingWakeKeys.clear();
            // DSH 重启后，recovery 去重也要重置：否则那批未读会被判定"已补过"，她永远等不到唤醒
            for (const rk of socialV2.conversations.keys()) {
              const rst = getSocialV2State(rk);
              if (rst) rst.recoveryForSeq = 0;
            }
            try { saveSocialV2State(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:4526'); }
            log(`[stale-turn] DSH 重启（离线 ${Math.round(downMs / 1000)}s）后清理 ${staleTurns} 个残留回合标记（collectors ${nCollectors} / turnStart ${nTurnStart} / pendingWake ${nPendingWake}），解除可能存在的 busy`);
          }
        } catch (error) {
          log(`[stale-turn] 清理残留回合失败（忽略）: ${error?.message ?? error}`);
        }
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        // [STALE-TURN] 启动补偿：桥接重启会丢掉"未处理完的唤醒"，未读消息就一直躺着
        // （实测：14:19 的消息在 14:20 重启后再没人管）。这里给「最近 10 分钟内有未读」
        // 的会话补一次唤醒；超过 10 分钟的不补，避免重启后翻旧账式补回复。
        if (!firstReadyRecovered) {
          firstReadyRecovered = true;
          try {
            const nowMs = Date.now();
            for (const rk of socialV2.conversations.keys()) {
              const rst = getSocialV2State(rk);
              const pending = Array.isArray(rst.unread) ? rst.unread.filter((m) => m && !m.isSelf) : [];
              if (!pending.length) continue;
              // 未读条目上的时间字段是 time（不是 at）；优先用会话级 lastIncomingAt 更稳
              const newestAt = Number(rst.lastIncomingAt)
                || Math.max(0, ...pending.map((m) => Number(m.time) || Number(m.at) || 0));
              const ageMs = nowMs - newestAt;
              const winMs = Math.max(60000, Number(cfg.socialV2?.recoveryWindowMs) || 10 * 60 * 1000);
              if (!(ageMs >= 0) || ageMs > winMs) continue;
              // [RECOVERY-DEDUPE] 桥接反复重启时，同一批未读会被反复补唤醒（实测 10-25 全天 82 次
              // recovery 回合、68% 什么都没做，其中多数是开发期多次重启）。按"最新的未读 seq"去重：
              // 没有更新的消息进来就不再补；有新消息 seq 变了自然放行。
              const newestSeq = Math.max(0, ...pending.map((m) => Number(m.seq) || 0));
              // [RECOVERY-COOLDOWN] 只按 seq 去重不够：群里持续有新消息时，每来一条就"补"一次
              // （实测 00:34–00:35 大约每 15 秒一次）。人也只是过一会儿想起来看一眼，不是每条都重来。
              const cooldownMs = Math.max(60000, Number(cfg.socialV2?.recoveryCooldownMs) || 5 * 60 * 1000);
              if (Number(rst.lastRecoveryWakeAt) > 0 && nowMs - Number(rst.lastRecoveryWakeAt) < cooldownMs) {
                log(`[recovery] ${rk} 距上次补唤醒不足 ${Math.round(cooldownMs / 60000)} 分钟，跳过`);
                continue;
              }
              // [RECOVERY-QUIET] 她刚开口（60s 内）就别补：否则 poke 回合刚发完，recovery 又唤醒一次，群里看到连发
              const sinceSpokeMs = nowMs - Number(rst.lastAiReplyAt || 0);
              if (Number(rst.lastAiReplyAt) > 0 && sinceSpokeMs < Math.max(15000, Number(cfg.socialV2?.recoveryQuietMs) || 60000)) {
                log(`[recovery] ${rk} 她 ${Math.round(sinceSpokeMs / 1000)}s 前刚说过话，不补唤醒（避免连发）`);
                continue;
              }
              if (newestSeq > 0 && Number(rst.recoveryForSeq) === newestSeq) {
                log(`[recovery] ${rk} 未读没有新进展（seq=${newestSeq} 已补过），跳过`);
                continue;
              }
              if (newestSeq > 0) { rst.recoveryForSeq = newestSeq; try { saveSocialV2State(); } catch (error) { log(`[recovery] 保存 recoveryForSeq 失败: ${error?.message ?? error}`); } }
              rst.lastRecoveryWakeAt = nowMs;
              log(`[recovery] ${rk} 有 ${pending.length} 条未读（最新 ${Math.round(ageMs / 1000)} 秒前），补一次唤醒`);
              setTimeout(() => { void scheduleWakeV2(rk, 'recovery'); }, 3000);
            }
          } catch (error) {
            log(`[recovery] 补唤醒失败（忽略）: ${error?.message ?? error}`);
          }
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      dshDownAt = Date.now(); // [STALE-TURN] 记录不可用起点，区分真重启与探测抖动
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  // [M-1] HTTP 控制台已搬到 console-server.mjs：依赖用 getter/setter 活绑定，
  // 模块内对 currentMode 等的赋值会写回这里的局部变量（不再有"两份状态"）。
  const consoleDeps = {
    get TUNE_PARAMS() { return TUNE_PARAMS; },
    get applyTuning() { return applyTuning; },
    // [SELF-NARRATIVE] 她自己写的自述：控制台端点读写这一层
    get loadSelfNarrative() { return loadSelfNarrative; },
    get saveSelfNarrative() { return saveSelfNarrative; },
    get readTuningFile() { return readTuningFile; },
    // [PERSON-MEMORY] 按 QQ 翻记忆：人物昵称 + 记忆库文本过滤
    get recall() { return recall; },
    get personAliasesOf() { return personAliasesOf; },
    get personRecordOf() { return personRecordOf; },
    get filterEntriesByPerson() { return filterEntriesByPerson; },
    get ACTIVE_WAIT_LEASE_MS() { return ACTIVE_WAIT_LEASE_MS; },
    get ACTIVITY_LOG() { return ACTIVITY_LOG; },
    get FEEDBACK_FILE() { return FEEDBACK_FILE; },
    get HER_WORKSPACE_DIR() { return HER_WORKSPACE_DIR; },
    get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
    // [WIRING-FIX] 2026-11-03：console-server 清空工作区时会 __deps.CONVERSATION_TOKENS.clear()，
    // 但这个 Map 归 bootstrap/agent-tokens 所有、之前没导出也没进 facade ⇒ 清空工作区抛 TypeError。
    get CONVERSATION_TOKENS() { return CONVERSATION_TOKENS; },
    get LOG_DIR() { return LOG_DIR; },
    get MAX_MEDIA_BYTES() { return MAX_MEDIA_BYTES; },
    get MAX_MEDIA_PIXELS() { return MAX_MEDIA_PIXELS; },
    get MEM_DIR() { return MEM_DIR; },
    get PRESET_BACKUP_DIR() { return PRESET_BACKUP_DIR; },
    get PRESET_NAMES() { return PRESET_NAMES; },
    get REASONING_EFFORT_DEFAULT() { return REASONING_EFFORT_DEFAULT; },
    get REASONING_EFFORT_OPTIONS() { return REASONING_EFFORT_OPTIONS; },
    get ROLES_DIR() { return ROLES_DIR; },
    get ROLE_CONTENT_MAX_BYTES() { return ROLE_CONTENT_MAX_BYTES; },
    get ROLE_NAME_MAX() { return ROLE_NAME_MAX; },
    get ROOT() { return ROOT; },
    get SENSITIVE_RE() { return SENSITIVE_RE; },
    get SLANG_STATUS() { return SLANG_STATUS; },
    get SOCIAL_V2_FILE() { return SOCIAL_V2_FILE; },
    get STATE_DATA_DIR() { return STATE_DATA_DIR; },
    get STATE_DIR() { return STATE_DIR; },
    get STICKER_FILE() { return STICKER_FILE; },
    get TOOL_LOG_FILE() { return TOOL_LOG_FILE; },
    get TREND_SOURCES() { return TREND_SOURCES; },
    get VALID_MODES() { return VALID_MODES; },
    get WORK_STATUS() { return WORK_STATUS; },
    get acknowledgeMessagesV2() { return acknowledgeMessagesV2; },
    get activeWaits() { return activeWaits; },
    get activeWorks() { return activeWorks; },
    get addProgress() { return addProgress; },
    get allowSlangSubmit() { return allowSlangSubmit; },
    get allowed() { return allowed; },
    get anyTurnBusyProbe() { return anyTurnBusyProbe; },
    get api() { return api; },
    get appendActivity() { return appendActivity; },
    get appendFeedbackEntry() { return appendFeedbackEntry; },
    get appendMemoryV2() { return appendMemoryV2; },
    get appendTask() { return appendTask; },
    get resumeTask() { return resumeTask; },
    get findResumableTask() { return findResumableTask; },
    get drainTaskPool() { return drainTaskPool; },
    get applyRoleInjectLimit() { return applyRoleInjectLimit; },
    get applyStickerNoteV2() { return applyStickerNoteV2; },
    get assertGroupMember() { return assertGroupMember; },
    get atomicWriteJson() { return atomicWriteJson; },
    get atomicWriteText() { return atomicWriteText; },
    get auditAndSend() { return auditAndSend; },
    get backupPresetFile() { return backupPresetFile; },
    get bot() { return bot; },
    get oneBotHealth() { return oneBotHealth; },
    get buildSlangContext() { return buildSlangContext; },
    get buildStickerContext() { return buildStickerContext; },
    get buildStickerStrategyHint() { return buildStickerStrategyHint; },
    get buildTrends() { return buildTrends; },
    get busySinceMs() { return busySinceMs; },
    get canDispatch() { return canDispatch; },
    get cancelAllSocialTimers() { return cancelAllSocialTimers; },
    get cancelPendingEntry() { return cancelPendingEntry; },
    get cancelReplyCheckV2() { return cancelReplyCheckV2; },
    get cancelSocialTimers() { return cancelSocialTimers; },
    get canonicalV2Key() { return canonicalV2Key; },
    get captionStickerLibrary() { return captionStickerLibrary; },
    get cfg() { return cfg; },
    get cfgRef() { return cfgRef; },
    // [WIRING-FIX] 2026-11-03：删掉 `get changed()`。它引用的标识符从未声明，唯一读点
    // console-server:1623 已改为本地 revoke.changed；留着就是一个谁读谁抛 ReferenceError 的死条目。
    get claimEmbedSpawn() { return claimEmbedSpawn; },
    get cleanupSocialForModeChange() { return cleanupSocialForModeChange; },
    get clearAllPendingWakeLeases() { return clearAllPendingWakeLeases; },
    get clearAllSocialV2Timers() { return clearAllSocialV2Timers; },
    get clearSocialV2Timers() { return clearSocialV2Timers; },
    get closedAgentPreset() { return closedAgentPreset; },
    set closedAgentPreset(v) { closedAgentPreset = v; },
    get cognition() { return cognition; },
    get collectStickerV2() { return collectStickerV2; },
    get collectors() { return collectors; },
    get compactGroupMemories() { return maintenance.compactGroupMemories; },
    get computeGapsV2() { return computeGapsV2; },
    get computeMetrics() { return computeMetrics; },
    get computeWakeSafetyV2() { return computeWakeSafetyV2; },
    get confirmedSlangListV2() { return confirmedSlangListV2; },
    get createSlangEntry() { return createSlangEntry; },
    get createTaskSession() { return createTaskSession; },
    get crypto() { return crypto; },
    // [SELF-EDIT-CODE] 校验规则 + 子进程执行（先写→跑检查→不过回滚）
    get selfEditVerify() { return selfEditVerifyMod; },
    get execFileSync() { return execFileSync; },
    get currentMode() { return currentMode; },
    set currentMode(v) { currentMode = v; },
    get currentRoleHint() { return currentRoleHint; },
    get currentRoleHintV2() { return currentRoleHintV2; },
    get deleteWorkshop() { return deleteWorkshop; },
    get deliverPrompt() { return deliverPrompt; },
    get deliverTaskPrompt() { return deliverTaskPrompt; },
    get describeAudio() { return describeAudio; },
    get diaryAttempts() { return diaryAttempts; },
    get doneWish() { return doneWish; },
    get drainAllPromptQueues() { return drainAllPromptQueues; },
    get drainPromptQueue() { return drainPromptQueue; },
    get dshReady() { return dshReady; },
    get ensureSession() { return ensureSession; },
    get ensureWakeableV2() { return ensureWakeableV2; },
    get enterActive() { return enterActive; },
    get escapeCqText() { return escapeCqText; },
    get extractPresetPrefix() { return extractPresetPrefix; },
    get feedbackTimes() { return feedbackTimes; },
    get fetchMediaData() { return fetchMediaData; },
    get fetchModelCatalog() { return fetchModelCatalog; },
    get filesForScope() { return filesForScope; },
    get findCjkSpaceWarning() { return findCjkSpaceWarning; },
    get findMessageMedia() { return findMessageMedia; },
    get findSplitBoundaryWarning() { return findSplitBoundaryWarning; },
    get findWork() { return findWork; },
    get flushSummaries() { return flushSummaries; },
    get forgetAgentToken() { return forgetAgentToken; },
    get forgetCuriosity() { return forgetCuriosity; },
    get formatForwardResponse() { return formatForwardResponse; },
    get formatMemoryV2() { return formatMemoryV2; },
    get formatParticipationV2() { return formatParticipationV2; },
    get formatStickerList() { return formatStickerList; },
    get fs() { return fs; },
    get getImageDimensions() { return getImageDimensions; },
    get getSocialV2State() { return getSocialV2State; },
    get getStickerImageData() { return getStickerImageData; },
    get groupMutedUntil() { return groupMutedUntil; },
    get groupReadWindowText() { return groupReadWindowText; },
    get hardenStateDirAcl() { return hardenStateDirAcl; },
    get http() { return http; },
    get inspectAudio() { return inspectAudio; },
    get installedPresetYaml() { return installedPresetYaml; },
    get invalidateSlangLearnerSession() { return invalidateSlangLearnerSession; },
    get isSessionAllowedInCurrentMode() { return isSessionAllowedInCurrentMode; },
    get isSleepingConfigV2() { return isSleepingConfigV2; },
    get judgeSlangEntry() { return judgeSlangEntry; },
    get keyForAgentToken() { return keyForAgentToken; },
    get lastForcedAgentStickerSync() { return lastForcedAgentStickerSync; },
    set lastForcedAgentStickerSync(v) { lastForcedAgentStickerSync = v; },
    get lastMode() { return lastMode; },
    set lastMode(v) { lastMode = v; },
    get leaveActive() { return leaveActive; },
    get lifeNote() { return lifeNote; },
    get lifeState() { return life.get(); },
    get listAudioFiles() { return listAudioFiles; },
    get listPresetBackups() { return listPresetBackups; },
    get listWorkshop() { return listWorkshop; },
    get loadEntries() { return loadEntries; },
    get loadOrCreateConsoleToken() { return loadOrCreateConsoleToken; },
    get wasConsoleTokenCreatedOnLoad() { return wasConsoleTokenCreatedOnLoad; },
    get loadStickerStore() { return loadStickerStore; },
    get loadWishState() { return loadWishState; },
    // [WIRING-FIX] 2026-11-03：console-server 的"把挂心事提升成目标"端点要 __deps.loadGoals/saveGoals，
    // 但 consoleDeps 从来没提供这两个键（只在 pumpMuxDeps 里有）⇒ 该端点一调就 TypeError。
    get loadGoals() { return loadGoals; },
    get saveGoals() { return saveGoals; },
    get log() { return log; },
    get logAction() { return logAction; },
    get looksLikeUnfinished() { return looksLikeUnfinished; },
    get manualDirCommand() { return manualDirCommand; },
    get markInterest() { return markInterest; },
    get markReadCalledKeys() { return markReadCalledKeys; },
    get memberNickLookup() { return memberNickLookup; },
    get mergeEvidence() { return mergeEvidence; },
    get messageMediaStore() { return messageMediaStore; },
    get migrateTaskPoolOnce() { return migrateTaskPoolOnce; },
    get mimeFromBuffer() { return mimeFromBuffer; },
    get mimeFromUrl() { return mimeFromUrl; },
    get modeAllowed() { return modeAllowed; },
    get modelAppliedSessions() { return modelAppliedSessions; },
    get modelCatalogErrorLogged() { return modelCatalogErrorLogged; },
    get modelCatalogInFlight() { return modelCatalogInFlight; },
    set modelCatalogInFlight(v) { modelCatalogInFlight = v; },
    get modelSelectionEpoch() { return modelSelectionEpoch; },
    set modelSelectionEpoch(v) { modelSelectionEpoch = v; },
    get normalizeModeInput() { return normalizeModeInput; },
    get normalizeOwnerQQ() { return normalizeOwnerQQ; },
    get normalizeReasoningEffort() { return normalizeReasoningEffort; },
    get normalizeSpeakerIdsV2() { return normalizeSpeakerIdsV2; },
    get noteModelMessagesV2() { return noteModelMessagesV2; },
    get openCuriosityLoops() { return openCuriosityLoops; },
    get openWishItems() { return openWishItems; },
    get organizeMemoryFiles() { return organizeMemoryFiles; },
    // [WIRING-FIX] 2026-11-03：原先 `return ownerKey` 引用的标识符从未声明 ⇒ 控制台鉴权分支
    // 一读就 ReferenceError（agent token 校验直接崩）。key 的形状与 console-server 其它地方一致。
    get ownerKey() { return `private:${String(cfg.ownerQQ ?? '')}`; },
    get parseTargetKey() { return parseTargetKey; },
    get path() { return path; },
    get pending() { return pending; },
    get pendingJudgeList() { return pendingJudgeList; },
    get pendingSendToolCalls() { return pendingSendToolCalls; },
    get pendingWakeKeys() { return pendingWakeKeys; },
    get waitToolCalls() { return waitToolCalls; },
    get waitStartAt() { return waitStartAt; },
    get turnWaitMs() { return turnWaitMs; },
    get peopleIndex() { return peopleIndex; },
    get pickStickerByQuery() { return pickStickerByQuery; },
    get poolCap() { return poolCap; },
    get poolSave() { return poolSave; },
    get preSleepWaitBlockedV2() { return preSleepWaitBlockedV2; },
    get unseenCountV2() { return unseenCountV2; },
    get presetPromptBlockers() { return presetPromptBlockers; },
    get presetPromptWarnings() { return presetPromptWarnings; },
    get presetSourceYaml() { return presetSourceYaml; },
    get presetStatus() { return presetStatus; },
    get priceTable() { return priceTable; },
    get publicSlangEntry() { return publicSlangEntry; },
    get queueMax() { return queueMax; },
    get queueSlangTask() { return queueSlangTask; },
    get queued() { return queued; },
    get queuedCount() { return queuedCount; },
    get queuedHintAt() { return queuedHintAt; },
    get queuedWorks() { return queuedWorks; },
    get readActivityTail() { return readActivityTail; },
    get readConfigObject() { return readConfigObject; },
    get readFeedbackEntries() { return readFeedbackEntries; },
    get readJsonSafe() { return readJsonSafe; },
    get readPresetPromptText() { return readPresetPromptText; },
    get readRoleContent() { return readRoleContent; },
    get readRoleState() { return readRoleState; },
    get readThroughSeqV2() { return readThroughSeqV2; },
    get readTokenOkMain() { return readTokenOkMain; },
    get readToolLog() { return readToolLog; },
    get readWallEntries() { return readWallEntries; },
    get readWorkshop() { return readWorkshop; },
    get recallBlock() { return recallBlock; },
    get recentTaskReportAt() { return recentTaskReportAt; },
    get reconcileSessionPolicies() { return reconcileSessionPolicies; },
    get recordCuriosity() { return recordCuriosity; },
    get recordSentMessagesV2() { return recordSentMessagesV2; },
    get recordSelfMediaMessage() { return recordSelfMediaMessage; },
    get recordWish() { return recordWish; },
    get redactKnownTokensOnly() { return redactKnownTokensOnly; },
    get refreshAllDefaultWakeConfigsV2() { return refreshAllDefaultWakeConfigsV2; },
    get releaseLock() { return releaseLock; },
    get renderCuriosityLine() { return renderCuriosityLine; },
    // [DAYPLAN] 控制台路由用：校验/渲染今天的安排（她自己的，不随机）
    get normalizePlan() { return normalizePlan; },
    get dayKeyOf() { return dayKeyOf; },
    get renderDayPlanBlock() { return renderDayPlanBlock; },
    get renderPresetPromptYaml() { return renderPresetPromptYaml; },
    get renderSlangJudgeLine() { return renderSlangJudgeLine; },
    get renderWishLine() { return renderWishLine; },
    get replyTimingV2() { return replyTimingV2; },
    get requestedReadThroughSeqV2() { return requestedReadThroughSeqV2; },
    get resolveAudioProcessing() { return resolveAudioProcessing; },
    get resolvePresetName() { return resolvePresetName; },
    get resolveReplyInfo() { return resolveReplyInfo; },
    get resolveReplyTargetV2() { return resolveReplyTargetV2; },
    get resolveVoicePathForOperator() { return resolveVoicePathForOperator; },
    get resolveVoicePathForV2() { return resolveVoicePathForV2; },
    get retaskToQueued() { return retaskToQueued; },
    get reverse() { return reverse; },
    get roleCharStats() { return roleCharStats; },
    get roleFilePath() { return roleFilePath; },
    get roleHintForMode() { return roleHintForMode; },
    get roleInjectMaxChars() { return roleInjectMaxChars; },
    set roleInjectMaxChars(v) { roleInjectMaxChars = v; },
    get roleSectionReport() { return roleSectionReport; },
    get roleSummaries() { return roleSummaries; },
    get roleWarnings() { return roleWarnings; },
    get runSlangExtraction() { return runSlangExtraction; },
    get runSlangResearch() { return runSlangResearch; },
    get runningWorks() { return runningWorks; },
    get safeFetchBuffer() { return safeFetchBuffer; },
    get sanitizeRoleName() { return sanitizeRoleName; },
    get saveLifeFile() { return saveLifeFile; },
    get saveSlangStore() { return saveSlangStore; },
    get saveSocialV2State() { return saveSocialV2State; },
    get saveState() { return saveState; },
    get saveWishState() { return saveWishState; },
    get scheduleProactiveCheckV2() { return scheduleProactiveCheckV2; },
    get scheduleReplyCheckV2() { return scheduleReplyCheckV2; },
    get scheduleWakeV2() { return scheduleWakeV2; },
    get seenForwardIds() { return seenForwardIds; },
    get sendMessagesV2() { return sendMessagesV2; },
    get sendStickerV2() { return sendStickerV2; },
    // [IMAGEGEN] 生图：发图 / 出图 / 状态 / 关掉（按需拉起的那一套）
    get sendImageV2() { return sendImageV2; },
    get sendImageFileV2() { return sendImageFileV2; },
    get imageForV2() { return imageForV2; },
    get imageStatusV2() { return imageStatusV2; },
    get imageStopV2() { return imageStopV2; },
    get sendToolSucceededSessions() { return sendToolSucceededSessions; },
    get sendVoiceForV2() { return sendVoiceForV2; },
    get sendVoiceV2() { return sendVoiceV2; },
    get sendWakePromptV2() { return sendWakePromptV2; },
    get sessionEpoch() { return sessionEpoch; },
    set sessionEpoch(v) { sessionEpoch = v; },
    get sessionModels() { return sessionTelemetry.getMap(); },
    get sessionPromises() { return sessionPromises; },
    get setStickerRemarkV2() { return setStickerRemarkV2; },
    get setWorkStatus() { return setWorkStatus; },
    get setupSleepTimerV2() { return setupSleepTimerV2; },
    get shouldBlockSilentReply() { return shouldBlockSilentReply; },
    get slangEntries() { return slangEntries; },
    set slangEntries(v) { slangEntries = v; },
    get slangExtractionCooldowns() { return slangExtractionCooldowns; },
    get slangResearchingIds() { return slangResearchingIds; },
    get slangSubmitTimes() { return slangSubmitTimes; },
    get slangWindows() { return slangWindows; },
    get sleep() { return sleep; },
    get social() { return social; },
    get socialV2() { return socialV2; },
    get startDiarySession() { return startDiarySession; },
    get startWork() { return startWork; },
    get state() { return state; },
    get stateDataPath() { return stateDataPath; },
    get stateDirHardened() { return stateDirHardened; },
    set stateDirHardened(v) { stateDirHardened = v; },
    get stickerEnabled() { return stickerEnabled; },
    get stickerEntries() { return stickerService.getEntries(); },
    get stickerShortRefOf() { return stickerShortRefOf; },
    get stickerSyncedAt() { return stickerService.getSyncedAt(); },
    get stopRetiredSessionWork() { return stopRetiredSessionWork; },
    get suggestQuietMsV2() { return suggestQuietMsV2; },
    get syncStickerLibrary() { return syncStickerLibrary; },
    get taskBoardSnapshot() { return taskBoardSnapshot; },
    get taskPoolRunning() { return taskPoolRunning; },
    get text() { return text; },
    get textHash() { return textHash; },
    get todayDiaryWritten() { return todayDiaryWritten; },
    get tokenLedger() { return tokenLedger; },
    get toolCallNames() { return toolCallNames; },
    get truncateText() { return truncateText; },
    get unquoteJsonString() { return unquoteJsonString; },
    get unwrap() { return unwrap; },
    get updateWorkById() { return updateWorkById; },
    get v2ToolEnabled() { return v2ToolEnabled; },
    get v2TurnStartAt() { return v2TurnStartAt; },
    get validateRoleContent() { return validateRoleContent; },
    get validateRoleName() { return validateRoleName; },
    get verifyVoiceMessageSent() { return verifyVoiceMessageSent; },
    get vision() { return vision; },
    get voiceBudgetCheck() { return voiceBudgetCheck; },
    get voiceBudgetCommit() { return voiceBudgetCommit; },
    get voiceCfg() { return voiceCfg; },
    get voiceLibrary() { return voiceLibrary; },
    get wakeConfigMissCount() { return wakeConfigMissCount; },
    get wakeConfigUpdatedKeys() { return wakeConfigUpdatedKeys; },
    get withFileLock() { return withFileLock; },
    get withTimeout() { return withTimeout; },
    get worksStore() { return worksStore; },
    get workshopRun() { return workshopRun; },
    get writeJsonDocument() { return writeJsonDocument; },
    get writeRoleContent() { return writeRoleContent; },
    get writeRoleState() { return writeRoleState; },
    get writeWallEntries() { return writeWallEntries; },
    get writeWorkshop() { return writeWorkshop; },
    // [GAME-RESOURCES] 家底账本：控制台端点只用这两个纯函数（只收数字，凭据进不来）
    get normalizeGameResources() { return normalizeGameResources; },
    get mergeGameResources() { return mergeGameResources; },
    // [MY-DAY] 控制台「我都干了什么」端点：只读行为账
    get renderBehaviorLedger() { return renderBehaviorLedger; },
  };
  function startConsoleServer() {
    return startConsoleServerCore(consoleDeps);
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;
  // [WIRING-FIX] message-intake 的依赖里用到了它；module 内没有这个名字 → 每次 bump 都 ReferenceError
  const bumpSessionEpoch = () => { sessionEpoch += 1; };

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  // [S2-1] 队列与失败记账已抽到 outgoing-queue.mjs（有单测）；这里只留一个实例。
  const outgoing = createOutgoingQueue({
    onError: (error) => { try { log(`[outgoing] 队列任务异常（已隔离，不影响后续发送）：${error?.message ?? error}`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:5004'); } },
  });

  // 文本发送（自动转发/分条/发送观察/禁言跳过）已搬到 send-service.mjs（P3-RW-7）。
  // [MUTE-GATE] message-intake 读的唤醒跳过节流表仍留在 app。
  const muteWakeSkipped = new Map();
  // 未读水位（读消息收据/确认/自动 ack）已搬到 unread-state.mjs（P3-RW-2）。
  const unreadState = createUnreadState({ getSocialV2State, saveSocialV2State, log });
  const {
    readThroughSeqV2,
    noteModelMessagesV2,
    requestedReadThroughSeqV2,
    acknowledgeMessagesV2,
    ackCeilForReply,
    autoAckAfterSend,
  } = unreadState;

  const sendService = createSendService({
    // [WIRING-FIX] 发送超时显式注入（模块里原来引用的是 app.mjs 的顶层常量名）
    SEND_TIMEOUT_MS,
    cfg,
    log,
    knownAgentTokens: KNOWN_AGENT_TOKENS,
    captureSendGuard,
    stripSelfQuoting,
    sendLedger,
    splitForQQ,
    getOutgoing: () => outgoing,
    withTimeout,
    getBot: () => bot,
    escapeCqText,
    text,
    appendUndelivered,
    undeliveredFile: UNDELIVERED_FILE,
    sleep,
    getSocialV2State,
    getAutoAckAfterSend: () => autoAckAfterSend,
    relevanceCos,
    getSetInputStatus: () => setInputStatus,
    randInt,
  });
  const {
    redactKnownTokensOnly,
    groupMutedUntil,
    muteSkip,
    sendGuardCheckV2,
    sendToQQ,
    sendNotice,
    lastSendSucceeded,
    sendBurstToQQ,
  } = sendService;


  // OneBot 传输（消息段/输入状态/mime/尺寸）已搬到 onebot-transport.mjs（P3-RW-6）。
  const onebotTransport = createOneBotTransport({
    cfg,
    log,
    knownAgentTokens: KNOWN_AGENT_TOKENS,
    escapeCqText,
    fetch,
  });
  const { setInputStatus, onebotSend, mimeFromBuffer, mimeFromUrl, getImageDimensions } = onebotTransport;


  // 媒体获取/图片识别已搬到 media-service.mjs（P3-RW-49）。
  const mediaService = createMediaService({
    MAX_MEDIA_BYTES,
    fs,
    path,
    log,
    cfg,
    getBot: () => bot,
    vision,
    getImageDimensions,
    looksLikeImageBuffer,
    mimeFromBuffer,
    mimeFromUrl,
    safeFetchBuffer,
  });
  function base64FromMaybe(v) { return mediaService.base64FromMaybe(v); }
  function isSafeLocalMediaPath(p) { return mediaService.isSafeLocalMediaPath(p); }
  function isProbablySafeImageFileRef(f) { return mediaService.isProbablySafeImageFileRef(f); }
  function fetchOneBotImage(m) { return mediaService.fetchOneBotImage(m); }
  function fetchFaceMedia(m) { return mediaService.fetchFaceMedia(m); }
  function resolveMediaList(m) { return mediaService.resolveMediaList(m); }
  function fetchMediaData(m) { return mediaService.fetchMediaData(m); }
  function visionAsk(a, b, c, d) { return mediaService.visionAsk(a, b, c, d); }



  // 给库里没有备注的表情打标（limit 张；force=连有备注的也重标）
  // ── [STICKER-AI] 表情打标 / 表情池（2026-10-26 优化）──────────────────────────
  // 为什么：库里表情 desc/localNote 全空时，注入给她的清单是「（无备注，可先看图）」，
  // 而策略又要求"优先用备注能对上的、不要瞎发" → 她的理性选择就是不发（实测 0 次）。
  // 语义必须在入库时做掉；机器标的东西带 autoNoteAt 痕迹，她手写备注会覆盖（人工优先）。
  // 表情池/打标已搬到 sticker-pool-service.mjs（P3-RW-50）。
  const stickerPool = createStickerPool({
    MAX_MEDIA_BYTES,
    fs,
    path,
    cfg,
    log,
    isDshReady: () => dshReady, // [WIRING-FIX]
    getBot: () => bot, // [WIRING-FIX] bot 在 main() 后段才声明；收藏/改备注是运行期动作，闭包取值避开 TDZ
    STATE_DIR,
    STICKER_FILE,
    atomicWriteJson,
    stickerService,
    loadStickerStore,
    saveStickerStore,
    getStickerImageData,
    applyStickerNote,
    stickerEnabled,
    syncStickerLibrary,
    fetchMediaData,
    visionAsk,
    mimeFromBuffer,
    safeFetchBuffer,
    parseStickerCaption,
    evaluateCaptionRetry,
    evaluateAutoCollect,
    stickerShortRefOf,
    activityTracker,
    getStickerSyncedAt: () => stickerService.getSyncedAt(),
    getStickerResyncAt: () => stickerResyncAt,
    setStickerResyncAt: (v) => { stickerResyncAt = v; },
  });
  function captionStickerLibrary(a) { return stickerPool.captionStickerLibrary(a); }
  function poolMeta() { return stickerPool.poolMeta(); }
  function setPoolMeta(p) { return stickerPool.setPoolMeta(p); }
  function loadStickerPool() { return stickerPool.loadStickerPool(); }
  function saveStickerPool(i) { return stickerPool.saveStickerPool(i); }
  function recordStickerCandidate(a, b, c, d) { return stickerPool.recordStickerCandidate(a, b, c, d); }
  function autoCollectStickerFromPool(a, b) { return stickerPool.autoCollectStickerFromPool(a, b); }
  function captionPoolOne(a) { return stickerPool.captionPoolOne(a); }
  function stickerPoolLine(a, b) { return stickerPool.stickerPoolLine(a, b); }

  const activityFlushTimer = setInterval(() => {
    try {
      for (const { key, trace } of activityTracker.maybeIdleFinishAll()) {
        log(`[activity] ${trace.app} 记下 ${trace.steps.length} 步${trace.stuck ? '（有卡住）' : ''} → trace（${trace.result}，${key}）`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:5946'); }
  }, 60 * 1000);
  activityFlushTimer.unref?.();
  // ── [MEM-ORGANIZE] 记忆库有序整理（2026-10-27 落地）──────────────────────────
  // 体检实测：群库 75% 是滚动摘要，其中「近24h群像」每刷新一条就留一条（88 条里 16 条旧快照），
  // 检索时同一件事的多个旧版本互相竞争。这里只做**机械整理**：旧快照搬 _archive（可检索、不删），
  // 再落一份 index.json（按 kind/theme/天 计数）；内容判断一律不碰。
  // 记忆库机械整理已搬到 memory-organize-service.mjs（P3-RW-51）。
  const memoryOrganize = createMemoryOrganize({
    fs,
    path,
    cfg,
    MEM_DIR,
    log,
    planOrganize,
    atomicWriteJson,
  });
  function organizeMemoryFiles(opts) { return memoryOrganize.organizeMemoryFiles(opts); }
  // 出站发送流水线已搬到 send-pipeline-service.mjs（P3-RW-48）。
  const sendPipeline = createSendPipeline({
    getLifeState: () => life.get(),
    getTurnSeenHeads: () => turnSeenHeads,
    // [WIRING-FIX] 兴趣记账要落盘生活状态
    saveLifeFile,
    cfg,
    log,
    state,
    getSocialV2State,
    saveSocialV2State,
    isSessionAllowedInCurrentMode,
    getCurrentMode: () => currentMode,
    onebotSend,
    sendToQQ,
    sendNotice,
    sessionPolicy,
    splitClauses,
    stripSelfQuoting,
    createSendGuard,
    ackCeilForReply,
    autoAckAfterSend,
    maybeIntake,
    relevanceCos,
    sleep,
    randInt,
    loadMoodState,
    saveMoodState,
    noteMoodReply,
    effectiveWarmth,
    detectSleepClaim,
    detectLateSleepClaim,
    lifeNote,
    loadInterestEncounters,
    saveInterestEncounters,
    detectLikes,
    recordEncounter,
    markInterest,
    addRumination,
    detectRumination,
    scheduleChaseV2,
    setInputStatus,
    shouldBlockSilentReplyPure,
    readRoleState,
    groupMutedUntil,
    muteSkip,
    appendActivity,
    outgoing,
    sendLedger,
    getMessageMediaStore: () => messageMediaStore,
    getSocialV2: () => socialV2,
  });

  function mediaHintFor(a, b, c) { return sendPipeline.mediaHintFor(a, b, c); }
  function findMessageMedia(a, b) { return sendPipeline.findMessageMedia(a, b); }
  function clampGapV2(a, b) { return sendPipeline.clampGapV2(a, b); }
  function computeGapsV2(a, b, c, d, e) { return sendPipeline.computeGapsV2(a, b, c, d, e); }
  function sendMessagesV2(a, b, c, d, e) { return sendPipeline.sendMessagesV2(a, b, c, d, e); }
  function shouldAuditKey(key) { return sendPipeline.shouldAuditKey(key); }
  function captureSendGuard(key) { return sendPipeline.captureSendGuard(key); }
  function shouldBlockSilentReply(a, b) { return sendPipeline.shouldBlockSilentReply(a, b); }
  function auditAndSend(a, b) { return sendPipeline.auditAndSend(a, b); }

  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 会话模型应用已搬到 session-model-service.mjs（P3-RW-54）。
  const sessionModel = createSessionModel({
    cfg,
    log,
    api,
    unwrap,
    sleep,
    modelAppliedSessions,
    getModelSelectionEpoch: () => modelSelectionEpoch,
    REASONING_EFFORT_DEFAULT,
  });
  function ensureChatModel(sessionId, effortOverride) { return sessionModel.ensureChatModel(sessionId, effortOverride); }


  // 会话创建（ensureSession）已搬到 session-create.mjs（P3-RW-11）。
  const sessionCreate = createSessionCreate({
    getState: () => state,
    getSessionEpoch: () => sessionEpoch,
    getCfg: () => cfg,
    getCurrentMode: () => currentMode,
    getDshPresetIds: () => dshPresetIds,
    sessionPolicy,
    isSessionAllowedInCurrentMode,
    isCurrentSession,
    retireSession,
    ensureChatModel,
    ensureHerWorkspace,
    resetHerWorkspace: () => { herWorkspacePromise = null; },
    modePreset,
    api,
    unwrap,
    log,
    sessionPromises,
    reverse,
    laneBaseKey,
    saveState,
  });
  const { ensureSession } = sessionCreate;


  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  function randInt(min, max) {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  }
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(v) { return wakeConfig.normalizeSpeakerIdsV2(v); }

  // 默认唤醒配置已搬到 wake-config-service.mjs（P3-RW-57）。
  const wakeConfig = createWakeConfig({
    cfg,
    getSocialV2: () => socialV2,
    saveSocialV2State,
  });
  function defaultWakeConfigV2() { return wakeConfig.defaultWakeConfigV2(); }
  function refreshDefaultWakeConfigV2(st) { return wakeConfig.refreshDefaultWakeConfigV2(st); }
  function refreshAllDefaultWakeConfigsV2() { return wakeConfig.refreshAllDefaultWakeConfigsV2(); }

  // [WRAP-UP-IS-JUDGEMENT] 收尾的门槛不是「安静够多久」，而是她自己的判断：
  // 「我插不上话了 / 这个话题跟我也没关系了」。
  // 2026-10-28 线上教训：旧实现要求「安静满 60s 或观察窗满足」，活跃群里这个条件永远不成立——
  // 她每一轮都在「想收尾 → 被拒 → 按提示等 → 等来新消息 → 再被拒」里循环，45 秒让位看门狗再补一刀，
  // 154 次让位取消、100 分钟零发言。
  // 现在机械前提只剩一个：最新消息得先到她眼前（还有没看过的才拦，让她先看完再判断）；
  // 看过之后想收就收，不用等任何人安静。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为「沉睡/潜水」
  }

  // 还有多少条消息是她没看过的（读完水位 lastReadThroughSeq 之后进来的）。
  // 收尾判断只卡这一个：没看到最新在聊什么，就没法判断「插不插得上话」。
  function unseenCountV2(st) {
    try {
      const lastUnread = Number(st?.lastUnreadSeq) || 0;
      return Math.max(0, lastUnread - readThroughSeqV2(st));
    } catch { return 0; }
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    // 旧开关保留：关掉就不再拦（迁移期兼容；语义已从「观察窗」变成「先看完未读」）。
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    // 看完了就让她自己判断——不再有静默计时、不再有「等够才能收尾」。
    return unseenCountV2(st) > 0;
  }

  // 社交状态核心（get/load/save/唤醒安全/未发话沉底）已搬到 social-state.mjs（P3-RW-14）。
  const socialStateSvc = createSocialState({
    socialV2,
    seenForwardIds,
    socialFile: SOCIAL_V2_FILE,
    log,
    readJsonSafe,
    atomicWriteJson,
    defaultWakeConfigV2,
    refreshDefaultWakeConfigV2,
    normalizeSpeakerIdsV2,
    canonicalV2Key,
    rememberAgentToken,
    sanitizeForwardId,
    scheduleProactiveCheckV2,
    setupSleepTimerV2,
    takeExpiredHint,
    sinkUnsentHint,
  });
  // 函数声明包一层：main 前段的工厂在 socialStateSvc 初始化前就会取这些引用，
  // 直接解构 const 会 TDZ；函数声明提升后，调用时再查 socialStateSvc 即可。
  function computeWakeSafetyV2(wc) { return socialStateSvc.computeWakeSafetyV2(wc); }
  function ensureWakeableV2(st, opts) { return socialStateSvc.ensureWakeableV2(st, opts); }
  function getSocialV2State(key) { return socialStateSvc.getSocialV2State(key); }
  function loadSocialV2State() { return socialStateSvc.loadSocialV2State(); }
  function saveSocialV2State() { return socialStateSvc.saveSocialV2State(); }
  function drainUnsentHints() { return socialStateSvc.drainUnsentHints(); }


  // 社交读取视图/记忆写入已搬到 social-format.mjs（P3-RW-13）。
  const socialFormat = createSocialFormat({
    cfg,
    isDirectedAtAi,
    looksLikeUnfinished,
    redactKnownTokensOnly,
    truncateText,
    readMemoryRows,
    getMemoryFile: () => MEMORY_FILE,
    appendJsonl,
    // [WIRING-FIX] appendJsonl 失败时的兜底写文件要用 fs
    fs,
    log,
    resetCoreFactsCache: () => { coreFactsCache = null; },
    saveSocialV2State,
  });
  const { formatParticipationV2, suggestQuietMsV2, formatMemoryV2, appendMemoryV2 } = socialFormat;

  loadSocialV2State();

  // 社交核心已搬到 social-core.mjs（P3-RW-25）。
  const socialCore = createSocialCore({
    getCurrentMode: () => currentMode,
    cfg,
    social,
    socialV2,
    selfNickname,
    truncateText,
    mediaHintFor,
    randInt,
    lifeTimePre,
    ruminationPre,
    DIRECTION_HINT,
    SPACE_SPLIT_HINT,
    SILENT_MARKER,
    currentRoleHint,
    getScheduleSocialReply: () => scheduleSocialReply,
    log,
    messageMediaStore,
    promptQueues,
    isSessionAllowedInCurrentMode,
    pendingWakeKeys,
    disarmPendingWakeLease,
    getDshReady: () => dshReady,
    queued,
    QUEUE_MAX,
    ownerLaneFor,
    OWNER_LANE_SUFFIX,
    ensureSession,
    enqueueForRetry,
    buildFreedomPolicy,
    formatFreedomLog,
    recordFreedomPolicy,
    stateDataPath,
    renderFreedomPermission,
    renderAgencyBlock,
    renderPragmaticContext,
    buildWakePromptV2,
    buildWakeSnapshotV2,
    renderWakeSnapshotV2,
    getSocialV2State,
    mergeBlocks,
    withSlangContext,
    resolveMediaList,
    isCurrentSession,
    submitPromptWithTurnSlot,
    turnDispatch,
    shouldAuditKey,
    SENSITIVE_RE,
    sendNotice,
    canonicalV2Key,
    noteModelMessagesV2,
    auditAndSend,
    mdToPlain,
  });
  function isSocialEnabled() { return socialCore.isSocialEnabled(); }
  function socialState(key) { return socialCore.socialState(key); }
  function isDirectAddress(a, b, c) { return socialCore.isDirectAddress(a, b, c); }
  function isDirectedAtAi(t) { return socialCore.isDirectedAtAi(t); }
  function isMustReplyText(t) { return socialCore.isMustReplyText(t); }
  function appendRecentMessage(...args) { return socialCore.appendRecentMessage(...args); }
  function appendSummary(...args) { return socialCore.appendSummary(...args); }
  function buildContextBlock(key) { return socialCore.buildContextBlock(key); }
  function enterActive(key) { return socialCore.enterActive(key); }
  function cancelSocialTimers(key) { return socialCore.cancelSocialTimers(key); }
  function cancelAllSocialTimers() { return socialCore.cancelAllSocialTimers(); }
  function cleanupSocialForModeChange() { return socialCore.cleanupSocialForModeChange(); }
  function leaveActive(key) { return socialCore.leaveActive(key); }
  function buildBatchPrompt(a, b, c) { return socialCore.buildBatchPrompt(a, b, c); }
  function buildProbePrompt(key) { return socialCore.buildProbePrompt(key); }
  function buildActiveExitPrompt(a, b) { return socialCore.buildActiveExitPrompt(a, b); }
  function triggerActiveDurationExit(a, b, c) { return socialCore.triggerActiveDurationExit(a, b, c); }
  function buildProactivePrompt(a, b) { return socialCore.buildProactivePrompt(a, b); }
  function deliverPromptNow(a, b, c) { return socialCore.deliverPromptNow(a, b, c); }
  // [ACTOR] 同一会话的投递串行化：并发再投（超时补投/控制台）不会交叉进同一个 DSH 会话。
  const conversationActors = createActorRegistry({
    onError: (error, meta) => log(`[actor] ${meta?.key ?? ''} 投递失败：${error?.message ?? error}`),
  });
  function deliverPrompt(a, b, c) {
    const key = String(a);
    // [MIND-SHADOW] 决策总线影子：每轮投递前构建一次不可变上下文并落生命线。
    // 不改变任何决策（R1 第一步）；MIND_CONTEXT_DEBUG=1 时额外打印摘要。
    try {
      if (mindGroundwork) {
        const mindCtx = buildDecisionContext({
          key,
          at: Date.now(),
          producers: {
            self: () => mindGroundwork.selfState,
            belief: () => mindBeliefFor(key),
          },
        });
        mindGroundwork.lifeLog.append(contextEventRow(mindCtx), { at: mindCtx.at });
        if (process.env.MIND_CONTEXT_DEBUG === '1') log('[mind] ' + contextSummary(mindCtx));
      }
    } catch (error) {
      log('[mind] 决策上下文构建失败（影子，忽略）: ' + (error?.message ?? error));
    }
    const actor = conversationActors.get(key);
    // 兜底：上一单已经卡住超过 2 分钟就不再排队，直接投递（避免把会话饿死）
    if (actor.inFlight() && Date.now() - actor.busySince() > 120000) {
      log(`[actor] ${key} 上一单超过 120s，直投（不走队列）`);
      return socialCore.deliverPrompt(a, b, c);
    }
    return actor.post(() => socialCore.deliverPrompt(a, b, c), { key });
  }
  function processPromptQueue(key) { return socialCore.processPromptQueue(key); }

  // 社交主循环（观望/活跃/试探/摘要投喂）已搬到 social-loop.mjs（P3-RW-21）。
  const socialLoop = createSocialLoop({
    social,
    cfg,
    log,
    randInt,
    deliverPrompt,
    isSocialEnabled,
    socialState,
    enterActive,
    currentRoleHint,
    buildProactivePrompt,
    triggerActiveDurationExit,
    isMustReplyText,
    appendSummary,
    buildBatchPrompt,
    leaveActive,
    buildProbePrompt,
    state,
    ensureSession,
    mediaHintFor,
    buildContextBlock,
  });
  const { scheduleSocialReply, socialLoopTick, startSocialLoop, flushSummaries } = socialLoop;


  // [BUSY-WATCH] 活着的回合没有看门狗：DSH 侧 turn/end 一旦丢失，v2TurnStartAt 会一直留着，
  // 会话从此永久「繁忙」（实测私聊卡了 13 分钟、26 条未读没被唤醒，@ 也就永远排不上）。
  // 每分钟体检一次：忙超过 busyStaleMs（默认 4 分钟）就问 DSH 该会话是否还在跑，
  // 不在跑就强制解除，并把暂存的唤醒原因挑最高优先级重发一次。
  // 忙回合看门狗（长 turn 让位/幽灵自愈/busy 上限/任务池巡检）已搬到 busy-watchdog.mjs（P3-RW-24）。
  const busyWatchdog = createBusyWatchdog({
    cfg,
    getDshReady: () => dshReady,
    taskPoolWatchdog,
    migrateTaskPoolOnce,
    pruneMissingSessions,
    socialV2,
    getSocialV2State,
    isConversationBusyV2,
    busySinceMs,
    log,
    state,
    collectors,
    v2TurnStartAt,
    pendingWakeKeys,
    promptQueues,
    disarmPendingWakeLease,
    wakePriorityV2,
    scheduleWakeV2,
    saveSocialV2State,
    api,
    unwrap,
    getWakeRetryTimers: () => wakeRetryTimers,
    getWakeRetryCounts: () => wakeRetryCounts,
    turnToolStats,
    sendToolSucceededSessions,
    getAutoCancelledKeys: () => autoCancelledKeys,
    waitToolCalls,
    waitStartAt,
    turnWaitMs,
    logAction,
  });
  const { startBusyWatchdog } = busyWatchdog;


  // [STARVE-FIX] "她正忙"的精确判据：最后一次真机操作（phone_*）在 3 分钟内。
  // 旧实现拿 lifeState.state==="active" + 10 分钟窗口当"正忙"，而她一连派活/做事就会把这个
  // 时间戳刷新——实测 10-25 她的"自己的时间"整天一次都没执行（firedToday 0、放弃 4 次）。
  let lastPhoneOpAt = 0;
  // [CLEANUP] 备份清理：.bak-<时间戳> 过期自动删（src/记忆/state 7 天，角色卡 30 天），防止备份堆积。
  // 运维维护（备份/日志裁剪/会话保留/记忆压缩/向量缓存）已搬到 maintenance-service.mjs（P3-RW-32）。
  const maintenance = createMaintenance({
    fs,
    path,
    cfg,
    log,
    state,
    isolatedSessions,
    getSlangLearnerSessionId: () => slangLearnerSessionId,
    learnerSessions,
    transientArchiveTimers,
    getTaskPoolRunning: () => taskPoolRunning,
    planRetention,
    sweepRetention,
    planStaleArchive,
    planOrphanRetention,
    HER_WORKSPACE_DIR,
    sessionKinds: getSessionKinds(),
    RETENTION_DEFAULTS,
    dshHomeDir,
    api,
    getDshReady: () => dshReady,
    MEM_DIR,
    STATE_DATA_DIR,
    STATE_DIR,
    stateDataPath,
    maintainMemoryDir,
    pruneUtterances,
    pruneRaw,
    pruneEmbeddingCaches,
  });


  // [SCHEDULER] 统一调度：own-life / 无聊轮 / free-tick 共用 ownlife 会话——同一时刻只允许一个回合在跑；
  // 忙则按优先级排队（own-life > 无聊 > free-tick），turn/end 时统一派发（消掉「并发投递互相挤」的竞态）。
  const OWNLIFE_QUEUE_FILE = path.join(STATE_DATA_DIR, 'ownlife-queue.json');
  let ownlifeQueue = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(OWNLIFE_QUEUE_FILE, 'utf8'));
      return Array.isArray(j?.queue) ? j.queue.filter((q) => q && q.reason && q.text) : [];
    } catch { return []; }
  })();
  function persistOwnlifeQueue() {
    try { atomicWriteJson(OWNLIFE_QUEUE_FILE, { queue: ownlifeQueue }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:7993'); }
  }
  // [PHONE-STATE] 手机现在能不能用（60 秒缓存；只在「确定没设备」时给一句话）
  let phoneProbeInst = null;
  const getPhoneProbe = () => {
    if (!phoneProbeInst) phoneProbeInst = createPhoneProbe({ adbPath: selectAdb({ phone: cfg?.phone, socialV2: cfg?.socialV2 }), execFile });
    return phoneProbeInst;
  };
  // [LIVE-LEARN] owner 的纠正一进来就记，不等下一次唤醒再扫。
  // 实时反馈（owner 纠正/工具失败/设备失败/练手位/活动菜单）已搬到 live-feedback-service.mjs（P3-RW-27）。
  const liveFeedback = createLiveFeedback({
    fs,
    cfg,
    log,
    stateDataPath,
    reverse,
    looksLikeCorrection,
    loadSessionNotes,
    addCorrection,
    saveSessionNotes,
    clearOpenLoops,
    shouldNoteToolFailure,
    classifyToolError,
    renderLiveHint,
    addOpenLoop,
    openLoopText,
    classifyFailure,
    loadSkills,
    pickPracticeSlots,
    DEFAULT_MAX_INJECTED,
    renderPracticeSlots,
    renderActivityMenu,
  });
  const { noteSessionCorrection, noteLiveToolResult, noteDeviceFailure, takeDeviceBlockedLine, practiceSlotLine, activityMenuLine } = liveFeedback;


  // ownlife 队列投递已搬到 ownlife-dispatch-service.mjs（P3-RW-55）。
  const ownlifeDispatch = createOwnLifeDispatch({
    getLastTurnStartAt: () => lastTurnStartAt,
    cfg,
    log,
    ownlifeQueue,
    persistOwnlifeQueue,
    ensureIsolatedSession,
    turnDispatch,
    getPhoneProbe,
    renderPhoneLine,
    activityMenuLine,
    practiceSlotLine,
    deliverToIsolated,
    isolatedDead,
    saveIsolatedDead,
  });
  function dispatchOwnlifeUnified(a, b) { return ownlifeDispatch.dispatchOwnlifeUnified(a, b); }
  function scheduleOwnlifeRetry(a, b, c, d, e) { return ownlifeDispatch.scheduleOwnlifeRetry(a, b, c, d, e); }
  function drainOwnlifeQueue() { return ownlifeDispatch.drainOwnlifeQueue(); }

  // 她自己的生活（定时器/独处 context/愿望补做）已搬到 ownlife-service.mjs（P3-RW-28）。
  // [IDLE-ASSOC] 独处时给提示接一条“被带出来的记忆”；读不到/图太小就空串，不阻塞。
  function buildOwnlifeAssociationLine() {
    try {
      const entries = loadEntries().slice(-80);
      if (entries.length < 2) return '';
      const graph = buildAssociationGraph(entries, { maxNodes: 80 });
      const activated = idleAssociations(graph, { steps: 3, topK: 2, seed: Date.now() % 100000 });
      return renderAssociationBlock(activated);
    } catch { return ''; }
  }
  const ownLifeService = createOwnLifeService({
    // [WIRING-FIX] 自主时间模块里读浏览轨迹/黑话判定队列/DSH 就绪态，原来引用的是 main() 的局部名（未声明）
    SLANG_FILE,
    getSlangEntries: () => slangEntries,
    getBrowseStore: () => browseStore,
    getDshReady: () => dshReady,
    // [WIRING-FIX] 独处时记「有活动了」要用 lifeNote
    lifeNote,
    fs,
    cfg,
    log,
    path,
    STATE_DIR,
    MEM_DIR,
    createOwnLife,
    getIdleAssociationLine: buildOwnlifeAssociationLine,
    mayOwnWake,
    drowsinessOf,
    getLifeState: () => life.get(),
    getLastPhoneOpAt: () => lastPhoneOpAt,
    socialV2,
    getCurrentMode: () => currentMode,
    getSocialV2State,
    loadGoals,
    loadLessons,
    filesForScope,
    summarizeRelationship,
    requireMemoryEntries,
    openCuriosityLoops,
    buildAutonomyPrompt,
    renderRelationship,
    lifeTimePre,
    ruminationPre,
    drainUnsentHints,
    renderUnsentLine,
    quantSnapshotLine,
    renderAgencyBlock,
    loadDayPlan,
    renderIntentionCandidates,
    buildIntentionCandidates,
    openWishItems,
    loadWishState,
    appendJsonl,
    deliverToIsolated,
    dispatchOwnlifeUnified,
    isConversationBusyV2,
    isSessionAllowedInCurrentMode,
    boredomOf,
    markInterest,
    dueWishes,
    markWishRun,
    pendingJudgeList,
    findUnknownTerms,
    renderUnknownTerms,
    loadSlang,
    renderSlangJudgeLine,
    sedimentBrowseIfAny,
    renderWanderNudge,
    saveLifeFile,
    saveWishState,
    sendWakePromptV2,
    renderLifeLine,
    renderCuriosityLine,
  });
  const { startOwnLife } = ownLifeService;


  // 真正决定启不启动的只有配置里的显式关闭开关。
  // （放在 own-life 定义之后：let 有 TDZ，先调用会抛 ReferenceError 并被 try 吞掉。）
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }
  // ★ 2026-10-23 修：原来 own-life 被挂在 v1 的 social.enabled 上，而本项目只开 socialV2
  // （social.enabled=false）→ startOwnLife 从未执行 → 日志里没有任何 [own-life] 记录，
  // 她也就从来没有"自己的时间"，只能被叫醒回话，谈不上自主动作链。
  // 现在只要 v2 开着就武装它。
  if (cfg.social?.enabled !== false || cfg.socialV2?.enabled !== false) {
    startOwnLife();
    startBusyWatchdog();
  }

  // [REFLECT] 夜间反思：由 harness 定时发起，不靠模型自觉。
  // 为什么必须这样做：实测 qq_memory_append / lesson_write 的调用次数是 0 ——
  // 提示词里写「偶尔用」的必然结果就是永远不用。所以改成定时投递 + 产出检查。
  // 读 JSONL（坏行跳过），供摘要判重使用
  // 每日摘要/行为快照已搬到 digest-service.mjs（P3-RW-23）。
  const digestService = createDigestService({
    fs,
    cfg,
    state,
    getSocialV2State,
    filesForScope,
    MEM_DIR,
    alreadyDigested,
    digestDay,
    renderBehaviorLedger,
    sanitizeFact,
    appendJsonl,
    log,
  });
  function readJsonlSafe(file) { return digestService.readJsonlSafe(file); }
  function writeDailyDigestV2() { return digestService.writeDailyDigestV2(); }
  function writeBehaviorMemorySnapshot() { return digestService.writeBehaviorMemorySnapshot(); }


  // 夜间反思已搬到 reflection-service.mjs（P3-RW-26）。
  const reflectionService = createReflectionService({
    // [WIRING-FIX] 反思产出检查要读「上一轮回合结果」，这是 main() 的局部量
    getLastThoughtTurn: () => lastThoughtTurn,
    // [WIRING-FIX] 夜间反思拼 prompt 要读生活状态与黑话库（原来是未声明的 main() 局部名）
    getLifeState: () => life.get(),
    // [LIFE-LOG-FEED] 反思素材：最近 24h 的生命线确定性摘要
    getLifeSummary: () => {
      try {
        if (!mindGroundwork) return '';
        const at = Date.now();
        const rows = mindGroundwork.lifeLog.read({ from: at - 24 * 3600 * 1000, to: at, limit: 500 });
        return summarizeOffline(rows, { now: at }).text;
      } catch { return ''; }
    },
    getSlangEntries: () => slangEntries,
    // [REFLECT-LIFE-LOG] 反思结果回写生命线：R7「反思产物可追溯」+ 事故可回放 + Aliveness 成长维。
    // 与既有 message.sent 落点同口径；写失败绝不能影响反思主流程。
    appendLifeEvent: (event) => {
      try { if (mindGroundwork) mindGroundwork.lifeLog.append(event); } catch { /* 生命线写失败不阻塞反思 */ }
    },
    fs,
    path,
    cfg,
    STATE_DATA_DIR,
    MEM_DIR,
    log,
    appendJsonl,
    writeJsonDocument,
    readJsonlSafe,
    deliverToIsolated,
    getSocialV2State,
    buildReflectPrompt,
    checkReflectOutcome,
    reflectShouldRun,
    summarizeLearning,
    renderLearningDigest,
    renderReflectLine,
    renderSlangJudgeLine,
    writeReflectInsight,
    loadGoals,
    loadLessons,
    writeDailyDigestV2,
    writeBehaviorMemorySnapshot,
    renderBehaviorLedger,
    stateDataPath,
  });
  const { startNightlyReflection } = reflectionService;


  // [INTAKE] 每轮学习：她说完话后追问一句「这段里有什么值得记的」。
  // 为什么必须由 harness 发起：写入工具的调用次数实测为 0 —— 靠自觉必然空。
  // 节流 8 分钟 + 新颖度判定（见 inori-intake.js），避免每轮都多烧一次调用。
  const INTAKE_STATE_FILE = stateDataPath('intake.json');
  const intakeLast = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(INTAKE_STATE_FILE, 'utf8'));
    for (const k of Object.keys(j ?? {})) intakeLast.set(k, Number(j[k]) || 0);
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:8803'); }

  // 入站网页读取/intake 投递已搬到 intake-service.mjs（P3-RW-30）。
  const intakeService = createIntakeService({
    fs,
    cfg,
    log,
    MEM_DIR,
    writeJsonDocument,
    INTAKE_STATE_FILE,
    intakeLast,
    loadLessons,
    makeLinkCache,
    safeFetch,
    shouldIntake,
    buildIntakePrompt,
    deliverToIsolated,
  });
  function saveIntakeState() { return intakeService.saveIntakeState(); }
  function stripHtml(html) { return intakeService.stripHtml(html); }
  function readPageForIntake(url, allowRender) { return intakeService.readPageForIntake(url, allowRender); }
  function maybeIntake(key, userText, selfText, seen) { return intakeService.maybeIntake(key, userText, selfText, seen); }


  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // [DEAD-CODE] 2026-11-03 删掉 `roleHintCache`：人格卡缓存真身在 role-hint.mjs（抽取后遗留的空壳）。
  // 原始人格卡（按 mtime 缓存，不截断）。
  // 人格卡热注入/示例改写/分条提示已搬到 role-hint.mjs（P3-RW-29）。
  const roleHintSvc = createRoleHint({
    readRoleState,
    sanitizeRoleName,
    ROLES_DIR,
    ROLE_STATE_FILE,
    getRoleInjectMaxChars: () => roleInjectMaxChars,
    truncateText,
    conditionedRoleText,
    log,
  });
  function roleRawContent() { return roleHintSvc.roleRawContent(); }
  function roleHintForMode(mode, contextText) { return roleHintSvc.roleHintForMode(mode, contextText); }
  function currentRoleHint() { return roleHintSvc.currentRoleHint(); }
  function isCjkLikeChar(ch) { return roleHintSvc.isCjkLikeChar(ch); }
  function convertExampleSpacesToComma(line) { return roleHintSvc.convertExampleSpacesToComma(line); }
  function findCjkSpaceWarning(messages) { return roleHintSvc.findCjkSpaceWarning(messages); }
  function findSplitBoundaryWarning(messages) { return roleHintSvc.findSplitBoundaryWarning(messages); }
  function currentRoleHintV2() { return roleHintSvc.currentRoleHintV2(); }


  // 群成员名/成员集合缓存已搬到 member-lookup-service.mjs（P3-RW-35）。
  const memberLookup = createMemberLookup({
    getBot: () => bot,
    log,
  });
  function pruneGroupMemberNameCache() { return memberLookup.pruneGroupMemberNameCache(); }
  function assertGroupMember(groupId, userId) { return memberLookup.assertGroupMember(groupId, userId); }
  function resolveGroupMemberName(groupId, userId) { return memberLookup.resolveGroupMemberName(groupId, userId); }


  // 引用消息解析已搬到 reply-target-service.mjs（P3-RW-36）。
  const replyTargetSvc = createReplyTarget({
    log,
    getBot: () => bot,
    cleanMemberName,
    segmentsToText,
    resolveGroupMemberName,
  });
  function pruneReplyInfoCache() { return replyTargetSvc.pruneReplyInfoCache(); }
  function resolveReplyInfo(kind, convId, messageId, selfId) { return replyTargetSvc.resolveReplyInfo(kind, convId, messageId, selfId); }
  function resolveReplyTargetV2(st, kind, convId, ref) { return replyTargetSvc.resolveReplyTargetV2(st, kind, convId, ref); }
  function firstReplyId(message) { return replyTargetSvc.firstReplyId(message); }
  // [WIRING-FIX] getMessageIntake() 的依赖里直接引用了这两个名字（对象简写），
  // 之前既没 import 也没包装 → 首次收消息时 ReferenceError。这里补接线。
  function isQuoteTargetOwner(message, kind, id, ownerQQ) { return replyTargetSvc.isQuoteTargetOwner(message, kind, id, ownerQQ); }
  function isQuoteTargetSelf(message, kind, id, selfId) { return replyTargetSvc.isQuoteTargetSelf(message, kind, id, selfId); }


  // 自我/关系/语用上下文已搬到 self-context-service.mjs（P3-RW-41）。
  const selfContext = createSelfContext({
    cfg,
    log,
    MEM_DIR,
    STATE_DATA_DIR,
    appendJsonl,
    stateHub: mindStateHub,
    applyEmotionCalibration,
    appraiseSelfEmotion,
    buildEmpathicStance,
    buildQuoteContext,
    canonScope,
    classifyPragmaticFrame,
    createDiscourseState,
    dedupeFacts,
    describeEdit,
    extractFacts,
    filesForScope,
    findLanguageEpisodesByContext,
    getSocialV2State,
    loadEntries,
    loadIntentions,
    loadMoodState,
    pickHerRecentEdit,
    readLanguageEpisodes,
    readOutcomes,
    renderDiscourseBlock,
    renderIntentionsBlock,
    renderLanguageEpisodeBlock,
    renderOutcomesBlock,
    renderPragmaticBlock,
    renderSelfEmotionBlock,
    renderSelfRecent,
    reverse,
    saveSocialV2State,
    stateDataPath,
    stateWithKey,
    updateDiscourseState,
    writeTextAtomic,
  });
  function readMemoryRows() { return selfContext.readMemoryRows(); }
  function maybeExtractFacts(a, b) { return selfContext.maybeExtractFacts(a, b); }
  function renderCoreFacts() { return selfContext.renderCoreFacts(); }
  function renderSelfProfile(model) { return selfContext.renderSelfProfile(model); }
  function loadSelfNarrative() { return selfContext.loadSelfNarrative(); }
  function saveSelfNarrative(text) { return selfContext.saveSelfNarrative(text); }
  function renderSelfNarrative() { return selfContext.renderSelfNarrative(); }
  function renderPragmaticContext(key) { return selfContext.renderPragmaticContext(key); }
  function renderAgencyBlock() { return selfContext.renderAgencyBlock(); }
  function renderSelfRecentBlock(key) { return selfContext.renderSelfRecentBlock(key); }
  function renderQuoteContext(key) { return selfContext.renderQuoteContext(key); }

  // 提示词候选行已搬到 prompt-candidates-service.mjs（P3-RW-43）。
  const promptCandidates = createPromptCandidates({
    cfg,
    log,
    TOOL_LOG_FILE,
    readJsonlSafe,
    collectLookups,
    cognition,
    pickCandidates,
    renderCandidates,
    getSocialV2State,
    saveSocialV2State,
    loadSkills,
    detectSkillCandidates,
    recentTraces,
    renderSkillCandidates,
  });
  const { renderKnowledgeCandidates, renderSkillCandidateLine } = promptCandidates;

  // 以前只有 buildWakePromptV2（有人叫她时）才注入自我档案 / 最近的样子 / 趋势 / 轨迹，
  // 她自己安排时间时只拿到角色卡。这块把同一套自我认识做成一个块，供隔离会话注入；
  // [SELF-MODEL-UNIFY] 聊天唤醒和自主时间共用同一套 self model 输入；
  // 以前 ownlife 只传 traces/lessons，缺 style/chase/adapt，两套“她”长得不一样。
  // 自我认知块（我是谁/最近怎么样/手头的事）已搬到 self-knowledge.mjs（P3-RW-16）。
  // [SELF-ANCHOR] 只读身份事实账；she 的定义由她自己的写入通道追加，这里不自动写。
  function selfAnchorLine() {
    try {
      const file = stateDataPath('mind', 'self-anchor.jsonl');
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return renderSelfAnchorLine(foldSelfAnchor(rows));
    } catch { return ''; }
  }
  const selfKnowledge = createSelfKnowledge({
    getSocialV2State,
    cfg,
    computeStyleStats,
    chaseState,
    getChaseAdaptMax: () => chaseAdaptMax,
    readJsonlSafe,
    path,
    stateDataPath,
    buildSelfModel,
    loadLessons,
    renderSelfNarrative,
    selfAnchorLine,
    renderSelfProfile,
    renderSelfModel,
    summarizeSelfTrend,
    renderSelfTrend,
    cognition,
    loadGoals,
    renderGoals,
    renderGoalOpenInvitation,
    activityTracker,
    renderTraceHint,
    renderThoughts,
    renderLessonCandidates,
    renderBehaviorLedger,
    summarizeLearningWrites,
    renderLearningWritesLine,
    renderSelfRecentBlock,
    renderLiveLearningBlocks,
    renderLedger,
    renderWorksLine,
    worksStore,
    renderSkillCandidateLine,
  });
  const { buildSelfModelForPrompt, selfKnowledgeBlock } = selfKnowledge;


  // ── [REASONING] 思考链：每回合的 reasoning 留一条摘要、长的留全文、失败回合留经验候选 ──
  // 背景（2026-10-29 调研）：思考在产生端是完整的（一天 537 条 assistant 消息里 264 条带思考），
  // 但桥接从来没读过 reasoning——跨回合不回放、跨唤醒只剩一句 thoughts、对学习零贡献。
  // 这里做三件事：
  //   A 回合结束把最后一段思考压成一句话进 thoughts.jsonl（下次醒来能看到"我上次是怎么想的"）；
  //   B 思考 ≥600 字的回合留全文到 reasoning-log.jsonl（有界 200 条），供复盘；
  //   C 失败回合的思考留一条到 lesson-candidates.jsonl（她自己再决定要不要 lesson_write 成经验）。
  const REASONING_LOG_FILE = stateDataPath('reasoning-log.jsonl');
  const LESSON_CANDIDATES_FILE = stateDataPath('lesson-candidates.jsonl');
  // [DEAD-CODE] 2026-11-03 删掉 `reasoningBuffers`：思考缓冲的真身在 reasoning-service.mjs（抽取后遗留）。

  /** 事件入口：收思考（turn/start 清缓冲，assistant/message 累积） */
  // 思考链留存/学习候选/群反馈/复读检测已搬到 reasoning-service.mjs（P3-RW-40）。
  const reasoningService = createReasoningService({
    cfg,
    log,
    fs,
    reverse,
    appendThought,
    readJsonlSafe,
    REASONING_LOG_FILE,
    LESSON_CANDIDATES_FILE,
    addRumination,
    loadMoodState,
  });
  function captureReasoning(a, b) { return reasoningService.captureReasoning(a, b); }
  function flushReasoning(a, b) { return reasoningService.flushReasoning(a, b); }
  function renderLessonCandidates(max) { return reasoningService.renderLessonCandidates(max); }
  function groupFeedbackRate(a, b) { return reasoningService.groupFeedbackRate(a, b); }
  function computeProactivity(a, b) { return reasoningService.computeProactivity(a, b); }
  function echoNorm(t) { return reasoningService.echoNorm(t); }
  function isPlusOneText(t) { return reasoningService.isPlusOneText(t); }
  function detectEchoChain(a, b, c) { return reasoningService.detectEchoChain(a, b, c); }

  // 入站消息/拍一拍写入已搬到 social-append.mjs（P3-RW-18）。
  const socialAppend = createSocialAppend({
    getSocialV2State,
    cleanMemberName,
    cfg,
    sanitizeForwardId,
    seenForwardIds,
    truncateText,
    truncateTextTail,
    recordRawAndClaims,
    detectEchoChain,
    maybeExtractFacts,
    sanitizeFact,
    extractFacts,
    noteMember,
    cancelChaseV2,
    chaseState,
    saveSocialV2State,
  });
  const { appendSocialV2Message, appendSocialV2Poke } = socialAppend;


  // [GROUP-TOPICS] 从近 24h 群摘要里提「常聊的具体词」，作为 group-fact 写入群库；
  // 零 LLM、6h 节流；目的是让「显卡/生日/插件」这类具体话题在检索里有钉子。
  // 群事实/群话题（话题提取/3B/flash 抽取）已搬到 group-facts.mjs（P3-RW-20）。
  const groupFacts = createGroupFacts({
    cfg,
    getSocialV2State,
    saveSocialV2State,
    log,
    MEM_DIR,
    filesForScope,
    loadEntries,
    appendJsonl,
    extractTopics,
    renderGroupTopics,
    ensureIsolatedSession,
    acquireTurnSlot,
    bindTurnGrant,
    releaseTurnGrant,
    groupFactSessions,
    groupFactWaiters,
    api,
    submitPromptWithTurnSlot,
    parseFactsJson,
    completeLocal3b,
  });
  const { appendGroupTopicsV2, askGroupFactsFlash, askGroupFactsLlm, appendGroupFactsLlmNow, appendGroupFactsLlm } = groupFacts;


  // 群记忆沉淀（digest/群像/3B 抽取/静默沉淀）已搬到 group-memory.mjs（P3-RW-19）。
  const groupMemory = createGroupMemory({
    cfg,
    getSocialV2State,
    saveSocialV2State,
    log,
    fs,
    path,
    MEM_DIR,
    filesForScope,
    loadEntries,
    appendJsonl,
    buildGroupDigest,
    sanitizeFact,
    withWindow,
    loadMoodState,
    appendGroupTopicsV2,
    appendGroupFactsLlm,
    summarizeGroupSpeakers,
    DEFAULT_EXTRACT,
    shouldExtractMemory,
    local3bAlive,
    ensureLocal3b,
    extractMemoryFacts,
    completeLocal3b,
  });
  const { writeGroupMemoryDigestV2, runMemoryExtractV2, appendGroupFactIfChangedV2, sedimentGroupMemoryIfStale } = groupMemory;


  // 原文/主张/自我媒体/发言记录已搬到 social-records-service.mjs（P3-RW-37）。
  const socialRecords = createSocialRecords({
    cfg,
    MEM_DIR,
    path,
    log,
    appendRaw,
    extractClaims,
    canonScope,
    filesForScope,
    claimToMemoryRow,
    appendJsonl,
    getSocialV2State,
    saveSocialV2State,
    writeGroupMemoryDigestV2,
    addRumination,
    redactKnownTokensOnly,
    recordSlangUsage,
    getSlangEntries: () => slangEntries,
    appendUtterance,
  });
  function recordRawAndClaims(key, msg) { return socialRecords.recordRawAndClaims(key, msg); }
  function recordSelfMediaMessage(key, label) { return socialRecords.recordSelfMediaMessage(key, label); }
  function recordSentMessagesV2(key, messages) { return socialRecords.recordSentMessagesV2(key, messages); }


  // 工具/学习闭环（反馈读写/工具日志/回合自动记技能）已搬到 tool-learning-service.mjs（P3-RW-31）。
  const toolLearning = createToolLearning({
    fs,
    cfg,
    log,
    readJsonSafe,
    atomicWriteJson,
    FEEDBACK_FILE,
    TOOL_LOG_FILE,
    redactSensitiveText,
    turnToolStats,
    getSocialV2State,
    takeTaskSkillIds,
    recordSkillAttempt,
    loadSkills,
    checkVerify,
    applyOutcome,
    saveSkills,
    saveSocialV2State,
  });
  const { readFeedbackEntries, appendFeedbackEntry, readToolLog, applyTurnToolLearning } = toolLearning;
  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);


// [FAIL-DIGEST] 工具失败 → 归类记账（失败原因实时归纳的数据面）
function noteToolFailure(key, toolName, errorText) {
  try {
    const log = loadFailures();
    const r = noteFailure(log, { key, tool: toolName, text: errorText });
    if (r.counted) { saveFailures(log); const why = explainFailure(errorText); log(`[fail] ${key || "task"} ${toolName || "?"} → ${r.cause.key}/${why.kind}（${why.kindLabel}）${String(errorText || "").slice(0, 80)}`); }
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:10545'); }
}

// [FAIL-REFLECT] 失败后同 key+工具又成功了 → 标记"解决"（这次换了什么法、用了多久）。
function resolveToolFailure(key, toolName) {
  try {
    const log = loadFailures();
    const r = resolveFailure(log, { key, tool: toolName });
    if (r) { saveFailures(log); log(`[fail-resolve] ${key || "task"} ${toolName} 好了（${Math.round((r.tookMs || 0) / 1000)}s，原因 ${r.cause || "?"}）`); }
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:10554'); }
}

function autoTraceToolFailure(key, toolName, errorText) {
  const err = String(errorText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!err) return;
  const h = `${key}|${toolName}|${err}`;
  const now = Date.now();
  if (now - (autoTraceSeen.get(h) || 0) < 30 * 60 * 1000) return;
  autoTraceSeen.set(h, now);
  if (autoTraceSeen.size > 500) {
    for (const [k, t] of autoTraceSeen) if (now - t > 6 * 3600000) autoTraceSeen.delete(k);
  }
  appendTrace({ goal: `调用工具：${toolName}`, steps: [err], result: 'fail', error: err, note: '桥接自动打点（工具失败）', scope: String(key ?? '') });
  log(`[auto-trace] ${key} 工具失败留痕：${toolName}｜${err.slice(0, 80)}`);
}

function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  // 工具参数脱敏已搬到 tool-redaction-service.mjs（P3-RW-38）。
  const toolRedaction = createToolRedaction({ redactSensitiveText, truncateText });
  const { redactSensitive, sanitizeToolArgs } = toolRedaction;


  function buildWakeSnapshotV2(key) {
    return buildWakeSnapshot(key, {
      getState: () => getSocialV2State(key),
      context: cfg.socialV2?.context ?? {},
      toolEnabled: v2ToolEnabled,
      readThroughSeq: readThroughSeqV2,
      compactModelMessage,
      log,
    });
  }

  // [W-1] 首回复只做「防抖」，不再强制等安静：
  // 旧实现用 minQuietAfterNewMs(10s)+suggestQuietMs 算，等于要求场子安静下来才轮到她，
  // 节奏上把她固化成接话者。现在只为合并对方连发的几条等 replyDebounceMs（默认 2 秒）。
  function replyTimingV2(st) {
    const debounce = Number(cfg.socialV2?.wait?.replyDebounceMs);
    return computeReplyTiming({
      now: Date.now(),
      lastIncomingAt: Number(st?.lastIncomingAt) || 0,
      debounceMs: Number.isFinite(debounce) ? Math.max(0, debounce) : REPLY_DEBOUNCE_MS,
    });
  }

  // 唤醒附加行（失败归纳 / 群里生词 / 遇到的东西）已搬到 wake-extra-lines.mjs（P3-1b 搬出）。
  // 冷却时间仍写在传入的 st 上，字段名不变；cfg 用 getter 现取，避免重启后才更新。
  const { wakeFailureLine, wakeGlossLine, wakeEncounterLine } = createWakeExtraLines({
    getCfg: () => cfg,
    loadFailures,
    loadInterestEncounters,
    log,
    slangFile: SLANG_FILE,
    languageEpisodesFile: stateDataPath('language-episodes.jsonl'),
  });

  // ── [AFFECT] 开口前判"对方这会儿像什么" ────────────────────────────────
  // GitHub 上的三层做法，全部用本机已有资产：
  //   ① 规则层（毫秒级，能判就不上模型）② 规则拿不准 → 已有 Qwen2.5-3B（按需起、闲置退）③ 融合后只给"假设"
  // 情绪/秘书/对话结构已搬到 wake-affect-service.mjs（P3-RW-39）。
  const wakeAffect = createWakeAffect({
    cfg,
    log,
    getSocialV2State,
    saveSocialV2State,
    scheduleWakeV2,
    aggregateFeel,
    renderFeelHint,
    correctTarget,
    fuseJudgement,
    isDirectedAtAi,
    classifyAffectOnnx,
    ensureEmotionServer,
    shouldTrustOnnx,
    onnxJudgement,
    pickExamples,
    judgeByModel,
    local3bAlive,
    local3bBase,
    ensureLocal3b,
    touchLocal3b,
    completeLocal3b,
    shouldJudge,
    gateEmbedTexts,
    buildSecretaryPrompt,
    parseSecretaryVerdict,
    secretaryAllows,
    shouldConsultSecretary,
    selfNickname,
    stateHub: mindStateHub,
    governor: resourceGovernor,
  });
  const { affectWhoLabel, prepareAffectHint, secretaryJudgeForWake, scheduleWakeWithSecretary, dialogStructureBlock } = wakeAffect;

  // 唤醒 prompt 组装（静默说明/实时学习/基底/提醒）已搬到 wake-prompt-service.mjs（P3-RW-15）。
  const wakePromptService = createWakePromptService({
    MEM_DIR,
    STATE_DIR,
    buildStickerContext,
    buildStickerStrategyHint,
    cfg,
    controlRoomLineFor,
    dialogStructureBlock,
    drainUnsentHints,
    evaluateSpeakGate,
    filesForScope,
    formatMemoryV2,
    formatParticipationV2,
    fs,
    getSocialV2State,
    imageHintLine,
    isSessionAllowedInCurrentMode,
    getLifeState,
    // [MIND-PROMPT] 内在状态与离线叙事：有数据才出现，无数据渲染空串
    getMindSelf: () => (mindGroundwork ? mindGroundwork.selfState : null),
    getMindNarrative: () => (mindGroundwork && typeof mindGroundwork.narrative === 'string' ? mindGroundwork.narrative : ''),
    getMindBelief: (k) => mindBeliefFor(k),
    // [LEGISLATION-VIEW] 立法账读端：state-hub 现读三本账（承诺/拒绝/自评），唤醒时可见。
    getMindLegislation: () => (mindStateHub && typeof mindStateHub.getLegislation === 'function' ? mindStateHub.getLegislation() : null),
    // [LESSONS-VIEW] 教训账读端：state-hub 现读 lessons-ledger.jsonl。
    getMindLessons: () => (mindStateHub && typeof mindStateHub.getLessonsLedger === 'function' ? mindStateHub.getLessonsLedger() : null),
    // [SELF-THREAD] §5.20：重逢时接上“刚才在想的事”。
    getMindSelfThread: () => (mindStateHub && typeof mindStateHub.getSelfThread === 'function' ? mindStateHub.getSelfThread() : null),
    getMindOwnerModel: () => (mindStateHub && typeof mindStateHub.getOwnerModel === 'function' ? mindStateHub.getOwnerModel() : null),
    loadWishState,
    log,
    looksLikeUnfinished,
    path,
    pickStickerByQuery,
    readRoleState,
    renderConversations,
    renderCuriosityLine,
    renderLifeLine,
    humanizeGap,
    renderPersonaCue,
    renderRecentLines,
    renderRelationship,
    renderUnsentLine,
    renderVoiceVarietyHint,
    renderWishLine,
    replyTimingV2,
    requireMemoryEntries,
    roleHintForMode,
    saveSocialV2State,
    selfNickname,
    silentGuardLine,
    socialV2,
    stickerEmptyBoxHint,
    getStickerEntries: () => stickerService.getEntries(),
    stickerPoolLine,
    stickerShortRefOf,
    summarizeRelationship,
    wakeEncounterLine,
    wakeFailureLine,
    wakeGlossLine,
    loadSessionNotes,
    looksLikeCorrection,
    addCorrection,
    pruneSessionNotes,
    saveSessionNotes,
    renderSessionNotesBlock,
    shouldInjectLearningItem,
    loadLearningItems,
    recentPractice,
    renderLearningItems,
    loadSkillDrafts,
    renderSkillDrafts,
    stateDataPath,
    renderWeeklyReview,
    renderDayPlanBlock,
    currentItem,
    loadDayPlan,
    // [PROMPT-TIER] readTuning 在下面才创建（main 后段）；这里的箭头只捕获绑定，
    // 真正读取发生在 buildWakePromptV2Base 时（那时已初始化），不会 TDZ。
    readTuning: (...args) => readTuning(...args),
  });
  // 函数声明包一层：main 前段的工厂会在 wakePromptService 初始化前取这些引用。
  function silentWakeNoteV2(key, reason) { return wakePromptService.silentWakeNoteV2(key, reason); }
  function renderLiveLearningBlocks(key, reason) { return wakePromptService.renderLiveLearningBlocks(key, reason); }
  function buildWakePromptV2Base(key, reason) { return wakePromptService.buildWakePromptV2Base(key, reason); }
  function buildWakePromptV2(key, reason) { return wakePromptService.buildWakePromptV2(key, reason); }
  function buildWakeReminderPromptV2(key) { return wakePromptService.buildWakeReminderPromptV2(key); }

  // [WAKE-RETRY] 高优先级唤醒（@/提问/关键词/引用）被「会话繁忙」暂存时，不能只依赖 turn/end 补发：
  // 那一轮若被 stale-turn watchdog 强行解除，补发分支根本不执行 —— 实测 atMention 暂存 3 次、实际派发 0 次。
  // 所以额外挂一个兜底定时器：到点会话不忙且该 seq 仍在未读里，就强制派发一次（每个会话只挂一个）。
  const wakeRetryTimers = new Map();
  // [AUTO-CANCEL] 系统让位取消的会话：turn/end(aborted) 时不发「⏹️ 已停止」
  const autoCancelledKeys = new Set();
  // [DEDUP] 会话最近一次任务交付时间：主会话的 replyCheck 跳过，避免重复说同一件事
  // recentTaskReportAt 已提前到任务服务初始化处。
  // [WAKE-RETRY-CAP] 无限重挂止损：DSH 重启/回合丢失时本地 busy 可能永远不清，
  // 兜底会每 20s 挂一次、永远不派发（实测：私聊唤醒被卡 5 分钟+）。最多重试 12 次（≈4 分钟）。
  const wakeRetryCounts = new Map();
  // [FLOOR-LOG] 判定落盘（data/state/floor-decisions.jsonl，8MB 轮转一份）
  const recordFloorDecision = createFloorLog({ file: stateDataPath('floor-decisions.jsonl') });
  // [SELF-TUNE] 她自己调的行为参数（data/state/tuning.json，按 mtime 缓存热读）
  const readTuning = createTuningReader(stateDataPath('tuning.json'));
  // [M-1] 调度层已搬到 wake-schedule.mjs：懒构造，首次调用时才取依赖快照（避开 TDZ）。
  // 唤醒运行时（调度器/发送器构造）已搬到 wake-runtime.mjs（P3-RW-42）。
  let wakeRuntimeInst = null;
  function getWakeRuntime() {
    if (!wakeRuntimeInst) {
      wakeRuntimeInst = createWakeRuntime({
    FOCUS_SLOTS,
    SAFE_INJECTION_CAPS,
    STATE_DATA_DIR,
    TOOL_LOG_FILE,
    UNDELIVERED_FILE,
    activityTracker,
    addressedJudgmentLine,
    applyReplyPace,
    appraiseValence,
    armAtSplit,
    armPendingWakeLease,
    armWakeRetryForPending,
    behaviorDigestRow,
    budgetWarnings,
    buildFreedomPolicy,
    buildLinkDigest,
    buildRecallQuery,
    buildSelfModel,
    buildWakePromptV2,
    cancelReplyCheckV2,
    cfg,
    chaseAdaptMax,
    chaseState,
    classifyTopic,
    cleanText,
    cognition,
    compactInjection,
    composeSelfSnapshot,
    computeGroupHabits,
    computeProactivity,
    computeStyleStats,
    decideMood,
    deliverPrompt,
    describeStyle,
    disarmPendingWakeLease,
    enforceInjectionBudget,
    lookupHintFor,
    SCENE_BUDGETS,
    ensureRerank,
    ensureWakeableV2,
    evaluateStyle,
    expireGoals,
    expireLessons,
    extractLinks,
    findSkills,
    formatBudgetLine,
    fs,
    getLifeState,
    getSocialV2State,
    readTuning,
    groupFeedbackRate,
    groupMutedUntil,
    inferLessonTrigger,
    isConversationBusyV2,
    isSameLocalDay,
    isSessionAllowedInCurrentMode,
    lessonPendingByKey,
    listUndelivered,
    loadFocus,
    loadGoals,
    loadLessons,
    loadMoodState,
    loadSkills,
    log,
    logAction,
    mergeBlocks,
    moodLine,
    muteWakeSkipped,
    noteSkillInjected,
    paceBatchMs,
    path,
    pendingWakeKeys,
    pickTalkingPeers,
    prepareAffectHint,
    questionHint,
    readJsonlSafe,
    readPageForIntake,
    readTuning,
    recallBlock,
    recordFloorDecision,
    renderBehaviorLedger,
    renderBehaviorLogLine,
    renderCoreFacts,
    renderFocusBlock,
    renderGoalIdeas,
    renderGoals,
    renderGraphLine,
    renderGroupHabits,
    renderInsightHints,
    renderKnowledgeCandidates,
    renderLearningWritesLine,
    renderLedger,
    renderLessons,
    renderMembers,
    renderPeerBotLine,
    renderQuoteContext,
    renderSelfModel,
    renderSelfProfile,
    renderSelfRecentBlock,
    renderSelfTrend,
    renderSkillCandidateLine,
    renderThoughts,
    renderTraceHint,
    renderUndeliveredLine,
    renderWorksLine,
    retireSession,
    rewriteLessons,
    runMemoryExtractV2,
    saveGoals,
    saveMoodState,
    saveSkills,
    saveSocialV2State,
    sedimentGroupMemoryIfStale,
    selectLessonsForContext,
    sendWakePromptV2,
    setupSleepTimerV2,
    shouldWake,
    sinkUnsentHint,
    socialGraph,
    socialV2,
    stampReplyPace,
    state,
    stateDataPath,
    stateWithKey,
    stripUrls,
    summarizeBehavior,
    summarizeLearningWrites,
    summarizePrompt,
    summarizeSelfTrend,
    takeDeviceBlockedLine,
    targetFromScene,
    tickMood,
    toolCallLogFile: TOOL_LOG_FILE,
    touchLesson,
    undeliveredFile: UNDELIVERED_FILE,
    wakePriorityV2,
    wakeRetryCounts,
    wakeRetryTimers,
    worksStore,
    getCurrentMode: () => currentMode,
      });
    }
    return wakeRuntimeInst;
  }
  function getWakeScheduler() { return getWakeRuntime().getWakeScheduler(); }
  function getWakeSender() { return getWakeRuntime().getWakeSender(); }

  function sendWakePromptV2(...args) { return getWakeSender().sendWakePromptV2(...args); }

  function scheduleWakeV2(...args) { return getWakeScheduler().scheduleWakeV2(...args); }
  function armWakeRetryForPending(...args) { return getWakeScheduler().armWakeRetryForPending(...args); }
  function scheduleProactiveCheckV2(...args) { return getWakeScheduler().scheduleProactiveCheckV2(...args); }

  // [SILENT-GUARD] 回复侧连续缺席计数：强触发（拍/@/名字/提问/关键词/议论她）的回合
  // 结束时，若本回合内她没通过工具开口（lastAiReplyAt 未越过派发基准 silentRef）→ streak+1；
  // 开口在发送工具侧清零（st.silentStreak / st.silentReminders）。软提示文案在唤醒基底
  // 拼装侧（buildWakePromptV2 → silentGuardLine），每连击最多递 2 次，永不上「必须回复」。
  // 回复检查/静默缺席计数已搬到 reply-check.mjs（P3-RW-17）。
  const replyCheck = createReplyCheck({
    getCurrentMode: () => currentMode,
    getSocialV2State,
    saveSocialV2State,
    log,
    cfg,
    socialV2,
    recentTaskReportAt,
    sendWakePromptV2,
    pendingWakeKeys,
    promptQueues,
    state,
    v2TurnStartAt,
    collectors,
    OWNER_LANE_SUFFIX,
  });
  function noteSilentTurnEndV2(key) { return replyCheck.noteSilentTurnEndV2(key); }
  function cancelReplyCheckV2(key) { return replyCheck.cancelReplyCheckV2(key); }
  function scheduleReplyCheckV2(key) { return replyCheck.scheduleReplyCheckV2(key); }
  function isConversationBusyV2(key, st) { return replyCheck.isConversationBusyV2(key, st); }
  // [RESTART-GATE] 全局忙碌判定：只算「真的有回合在跑」。
  // 不把排队的唤醒算进来——队列丢了不疼，正在说的那句被砍断才疼。
  anyTurnBusyProbe = () => {
    try { return turnDispatch.occupancy() > 0 || collectors.size > 0; } catch { return false; }
  };

  // [CONTROL-ROOM] 把这个键以外的场面也列出来：谁有未读、谁在跑、后台在干嘛。
  // 只陈述事实（不给指令），让她自己决定先看谁；超长时只留带未读或在跑的场面。
  // 中控台/唤醒优先级/逐条回 @ 已搬到 control-room-service.mjs（P3-RW-33）。
  const controlRoomSvc = createControlRoom({
    socialV2,
    isSessionAllowedInCurrentMode,
    isConversationBusyV2,
    buildScenes,
    isolatedSessions,
    renderOpsLine,
    turnDispatch,
    maxConcurrentTurns,
    log,
    cfg,
    pruneSplitQueue,
    isDirectedAtAi,
    saveSocialV2State,
    getSocialV2State,
    sendWakePromptV2,
  });
  function controlRoomLineFor(key) { return controlRoomSvc.controlRoomLineFor(key); }
  function wakePriorityV2(reason) { return controlRoomSvc.wakePriorityV2(reason); }
  function directedUnreadList(st) { return controlRoomSvc.directedUnreadList(st); }
  function armAtSplit(a, b, c) { return controlRoomSvc.armAtSplit(a, b, c); }
  function scheduleNextAtSplit(a, b) { return controlRoomSvc.scheduleNextAtSplit(a, b); }


  // ── [PACE] 场景化回复节奏 ───────────────────────────────────────────────
  // 谁在等（私聊/群、被点名/闲聊）、她什么状态（睡着/精力）、群里多热闹、几点 → 决定多快开口。
  // 只影响"多快"，不影响说什么；纯计算在 src/reply-pace.js（9 条单测锁）。
  // 社交节奏/睡眠/好奇心/队列清理已搬到 social-timing-service.mjs（P3-RW-34）。
  const socialTiming = createSocialTiming({
    cfg,
    log,
    logAction,
    // [WIRING-FIX] 社交节奏模块里几个裸引用改成注入：好奇种子要读 SLANG_FILE/STATE_DIR，
    // 昵称与模式是可变状态，必须走 getter（构造时取快照会永远是旧值）。
    SLANG_FILE,
    STATE_DIR,
    getSelfNickname: () => selfNickname,
    getCurrentMode: () => currentMode,
    // [C6] 插话概率微调：从她的 SelfState 取社交饥饿/精力/压力
    getSelfState: () => (mindStateHub ? mindStateHub.state.self : (mindGroundwork ? mindGroundwork.selfState : null)),
    stateHub: mindStateHub,
    saveLifeFile,
    fs,
    path,
    stateDataPath,
    sleep,
    reverse,
    socialV2,
    promptQueues,
    getSocialV2State,
    saveSocialV2State,
    appraiseValence,
    classifyTopic,
    computePace,
    decideMood,
    decideContinue,
    decideJoin,
    getLifeState,
    loadGoals,
    loadMoodState,
    stateWithKey,
    tickMood,
    isDirectedAtAi,
    loadSlang,
    findUnknownTerms,
    loadLessons,
    loadInterestEncounters,
    saveInterestEncounters,
    recordCuriosity,
    recordEncounter,
    markCuriosityStimulus,
    computeProactivity,
    sendWakePromptV2,
    scheduleWakeWithSecretary,
    isConversationBusyV2,
    isSessionAllowedInCurrentMode,
    cancelReplyCheckV2,
    assumeMoreComing,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    messageMediaStore,
  });
  function replyPaceContext(key, reason) { return socialTiming.replyPaceContext(key, reason); }
  function stampReplyPace(a, b, c) { return socialTiming.stampReplyPace(a, b, c); }
  function lastIncomingV2(st) { return socialTiming.lastIncomingV2(st); }
  async function waitNextDecision(a, b) { return socialTiming.waitNextDecision(a, b); }
  function applyReplyPace(a, b) { return socialTiming.applyReplyPace(a, b); }
  function paceBatchMs(a, b, c) { return socialTiming.paceBatchMs(a, b, c); }
  function setupSleepTimerV2(key) { return socialTiming.setupSleepTimerV2(key); }
  function seedCuriosityFromChat(a, b) { return socialTiming.seedCuriosityFromChat(a, b); }
  function maybeJoinOrContinue(a, b, c) { return socialTiming.maybeJoinOrContinue(a, b, c); }
  function clearSocialV2Timers(key) { return socialTiming.clearSocialV2Timers(key); }
  function clearAllSocialV2Timers() {
    const r = socialTiming.clearAllSocialV2Timers();
    // [MODE-CLEANUP] 唤醒兜底定时器/计数在 app 层，旧实现只清 socialTiming 内部定时器，
    // 模式切走后这些 20s 定时器仍会检查并可能派发唤醒（虽被 wakeBlocked 二次拦下，但句柄
    // 与计数会残留到下一次模式切回）。补投退避计时同理，一并清掉。
    for (const t of wakeRetryTimers.values()) clearTimeout(t);
    wakeRetryTimers.clear();
    wakeRetryCounts.clear();
    queueRetries.clear();
    return r;
  }
  // [WIRING-FIX] 第二个参数是清空排队 prompt 时给调用方的错误文案；旧包装只收 key，
  // message-intake 传进来的「会话已重置」被丢掉，排队者只会拿到空错误。
  function drainPromptQueue(key, errorMsg) { return socialTiming.drainPromptQueue(key, errorMsg); }
  function drainAllPromptQueues(errorMsg) { return socialTiming.drainAllPromptQueues(errorMsg); }

  // [WIRING-FIX] messageIntakeInst 以前从没声明过：`if (!messageIntakeInst)` 是读未声明标识符，
  // ESM 严格模式下直接 ReferenceError → getMessageIntake() 每次调用都炸（入站消息全走这里）。
  let messageIntakeInst = null;
  function getMessageIntake() {
    if (!messageIntakeInst) {
      messageIntakeInst = createMessageIntake({
        DIRECTION_HINT,
        MAX_MEDIA_STORE_PER_KEY,
        QUEUE_HINT_COOLDOWN_MS,
        QUEUE_MAX,
        ROOT,
        SENSITIVE_RE,
        SILENT_MARKER,
        SPACE_SPLIT_HINT,
        allowed,
        api,
        appendActivity,
        appendRecentMessage,
        appendSocialV2Message,
        appendSummary,
        auditAndSend,
        bot,
        buildContextBlock,
        bumpSessionEpoch,
        classifyPragmaticFrame,
        createDiscourseState,
        updateDiscourseState,
        applyEmotionCalibration,
        detectEmotionCorrection,
        recordEmotionFeedback,
        cancelPendingEntry,
        cancelSocialTimers,
        cleanMemberName,
        clearSocialV2Timers,
        collectors,
        convKey,
        currentMode,
        getCurrentMode: () => currentMode,
        getDshReady: () => dshReady,
        currentRoleHint,
        deliverPrompt,
        drainPromptQueue,
        dshReady,
        enqueueForRetry,
        ensureSession,
        ensureChatModel,
        chatEffortFor: (key) => (String(key).startsWith('private:')
          ? String(cfg.dsh?.privateReasoningEffort || 'high')
          : String(cfg.dsh?.reasoningEffort || 'max')),
        enterActive,
        evaluateWakeTriggerV2,
        secretaryJudge: secretaryJudgeForWake,
        secretaryAllows,
        extractForwardIds,
        extractLinks,
        extractMediaFromSegments,
        feedSlangWindow,
        firstReplyId,
        forgetAgentToken,
        formatForwardResponse,
        fs,
        getSocialV2State,
        handlePendingAnswer,
        isCurrentSession,
        isDirectAddress,
        isQuoteTargetOwner,
        isQuoteTargetSelf,
        isSessionAllowedInCurrentMode,
        isSocialEnabled,
        lifeNote,
        getLifeState,
        touchLifeInterest,
        log,
        markInterest,
        markReadCalledKeys,
        maybeJoinOrContinue,
        mdToPlain,
        mediaHintFor,
        messageAtsSelf,
        messageMediaStore,
        modeAllowed,
        modelAppliedSessions,
        noteEdge,
        noteCorrection: noteSessionCorrection,
        path,
        pending,
        pendingSendToolCalls,
        pendingWakeKeys,
        waitToolCalls,
        waitStartAt,
        turnWaitMs,
        polarityOf,
        queued,
        queuedHintAt,
        readPageForIntake,
        readRoleState,
        recordStickerCandidate,
        resolveGroupMemberName,
        resolveMediaList,
        resolveReplyInfo,
        reverse,
        sanitizeRoleName,
        saveLifeFile,
        saveSocialGraphSoon,
        saveSocialV2State,
        saveState,
        scheduleSocialReply,
        scheduleWakeV2,
        seedCuriosityFromChat,
        seenForwardIds,
        segmentsToText,
        selfNickname,
        sendNotice,
        sendToQQ,
        sendToolSucceededSessions,
        sessionEpoch,
        sessionPromises,
        shouldAuditKey,
        slangExtractionCooldowns,
        slangSubmitTimes,
        slangWindows,
        social,
        socialGraph,
        socialState,
        socialV2,
        state,
        submitPromptWithTurnSlot,
        toolCallNames,
        triggerActiveDurationExit,
        turnDispatch,
        v2TurnStartAt,
        wakeConfigMissCount,
        wakeConfigUpdatedKeys,
        withSlangContext,
        writeRoleState,
      });
    }
    return messageIntakeInst;
  }
  function handleIncoming(...args) {
    lastIncomingAt = Date.now(); // [FORCE-NAP] 有人在找她，强制小睡要等这波安静下来
    return getMessageIntake().handleIncoming(...args);
  }

  // 挂起请求/拍一拍处理已搬到 pending-service.mjs（P3-RW-22）。
  const pendingService = createPendingService({
    api,
    withTimeout,
    log,
    pending,
    sendNotice,
    sendToQQ,
    APPROVE_WORDS,
    REJECT_WORDS,
    cfg,
    getCurrentMode: () => currentMode,
    modeAllowed,
    convKey,
    appendActivity,
    cleanMemberName,
    resolveGroupMemberName,
    appendSocialV2Poke,
    socialV2,
    getSocialV2State,
    saveSocialV2State,
    scheduleWakeV2,
  });
  function cancelPendingEntry(entry) { return pendingService.cancelPendingEntry(entry); }
  function handlePendingAnswer(p, answerText, key, isOwner) { return pendingService.handlePendingAnswer(p, answerText, key, isOwner); }
  function handlePokeNotice(event) { return pendingService.handlePokeNotice(event); }
  function registerPending(key, entry) { return pendingService.registerPending(key, entry); }


  // DSH 事件流 → QQ
  // [M-1] pumpMux 的依赖活绑定（getter 取当前值，setter 写回 main 的局部变量）。
  // [LIFE-SENT] 发送工具成功 = 她真的往世界里说了话；只记元信息，不记正文。
  function noteLifeSent(lifeKey, tool) {
    try {
      if (!mindGroundwork) return;
      mindGroundwork.lifeLog.append({ type: 'message.sent', key: String(lifeKey || ''), payload: { tool: String(tool || '') } }, { at: Date.now() });
    } catch { /* 观测失败忽略 */ }
  }

  const pumpMuxDeps = {
    // [MUX-DISCONNECT] 断链时把未完成回合文本沉到底部容器（不直接发 QQ）。
    get appendUndelivered() { return appendUndelivered; },
    get undeliveredFile() { return UNDELIVERED_FILE; },
    get FOCUS_SLOTS() { return FOCUS_SLOTS; },
    get noteTurnStart() { return noteTurnStart; },
    get noteDeviceFailure() { return noteDeviceFailure; },
    get noteLiveToolResult() { return noteLiveToolResult; },
    get parseTaskResult() { return parseTaskResult; },
    get FOCUS_SLOT_CN() { return FOCUS_SLOT_CN; },
    get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
    get SENSITIVE_RE() { return SENSITIVE_RE; },
    get SILENT_MARKER() { return SILENT_MARKER; },
    get SILENT_TURN_TIMEOUT_MS() { return SILENT_TURN_TIMEOUT_MS; },
    get SLANG_FILE() { return SLANG_FILE; },
    get WORK_STATUS() { return WORK_STATUS; },
    get activeWaits() { return activeWaits; },
    get activityTracker() { return activityTracker; },
    get loadSelfNarrative() { return loadSelfNarrative; },
    get saveSelfNarrative() { return saveSelfNarrative; },
    get captureReasoning() { return captureReasoning; },
    get flushReasoning() { return flushReasoning; },
    get addGoalIdea() { return addGoalIdea; },
    get addGoalRow() { return addGoalRow; },
    get addProgress() { return addProgress; },
    get addRumination() { return addRumination; },
    get api() { return api; },
    get appendActivity() { return appendActivity; },
    get appendTrace() { return appendTrace; },
    get checkVerify() { return checkVerify; },
    get appendDailyDiary() { return appendDailyDiary; },
    get appendGateLog() { return appendGateLog; },
    get appendThought() { return appendThought; },
    get emitSelfThread() { return (thought, at) => { try { selfThreadEmitterHolder.current?.(thought, at); } catch { /* best-effort */ } }; },
    get appendToolLog() { return appendToolLog; },
    get applyGateHits() { return applyGateHits; },
    get applyTurnToolLearning() { return applyTurnToolLearning; },
    get armPendingWakeLease() { return armPendingWakeLease; },
    get autoCancelledKeys() { return autoCancelledKeys; },
    get autoTraceToolFailure() { return autoTraceToolFailure; },
    get browseLearnWindow() { return browseLearnWindow; },
    get browseSave() { return browseSave; },
    get browseStore() { return browseStore; },
    set browseStore(v) { browseStore = v; },
    get buildWakeReminderPromptV2() { return buildWakeReminderPromptV2; },
    get busySinceMs() { return busySinceMs; },
    get cancelPendingEntry() { return cancelPendingEntry; },
    get cancelTransientArchive() { return cancelTransientArchive; },
    get cfg() { return cfg; },
    get clearAllPendingWakeLeases() { return clearAllPendingWakeLeases; },
    get collectors() { return collectors; },
    get consumeTurnGrant() { return consumeTurnGrant; },
    get createTurnCollector() { return createTurnCollector; },
    get currentMode() { return currentMode; },
    get defaultWakeConfigV2() { return defaultWakeConfigV2; },
    get deliverPrompt() { return deliverPrompt; },
    get diaryAttempts() { return diaryAttempts; },
    get diaryForcedDays() { return diaryForcedDays; },
    get diarySessions() { return diarySessions; },
    get disarmPendingWakeLease() { return disarmPendingWakeLease; },
    get drainOwnlifeQueue() { return drainOwnlifeQueue; },
    get dropDiaryAttempt() { return dropDiaryAttempt; },
    get ensureWakeableV2() { return ensureWakeableV2; },
    get errToText() { return errToText; },
    get extractTerms() { return extractTerms; },
    get extractThoughtLines() { return extractThoughtLines; },
    get finishTask() { return finishTask; },
    get fs() { return fs; },
    get gateBatches() { return gateBatches; },
    get gateCollectors() { return gateCollectors; },
    get gateSessions() { return gateSessions; },
    get getSocialV2State() { return getSocialV2State; },
    get groupFactCollectors() { return groupFactCollectors; },
    get groupFactSessions() { return groupFactSessions; },
    get groupFactWaiters() { return groupFactWaiters; },
    get isCurrentSession() { return isCurrentSession; },
    get isPhoneTool() { return isPhoneTool; },
    get isSendToolName() { return isSendToolName; },
    // [LIFE-SENT] 发送工具成功时落生命线（mux-bus 在 tool/result 成功分支调用）
    get noteLifeSent() { return noteLifeSent; },
    get isSilentMarker() { return isSilentMarker; },
    get isSocialEnabled() { return isSocialEnabled; },
    get isolatedDead() { return isolatedDead; },
    get isolatedKindBySession() { return isolatedKindBySession; },
    get isolatedSessions() { return isolatedSessions; },
    get lastPhoneOpAt() { return lastPhoneOpAt; },
    set lastPhoneOpAt(v) { lastPhoneOpAt = v; },
    get lastSendSucceeded() { return lastSendSucceeded; },
    get lastThoughtTurn() { return lastThoughtTurn; },
    set lastThoughtTurn(v) { lastThoughtTurn = v; },
    get learnerCollectors() { return learnerCollectors; },
    get learnerSessions() { return learnerSessions; },
    get learnerWaiters() { return learnerWaiters; },
    get lessonPendingByKey() { return lessonPendingByKey; },
    get lifeState() { return life.get(); },
    set lifeState(v) { life.set(v); },
    get loadGoals() { return loadGoals; },
    get loadLessons() { return loadLessons; },
    get log() { return log; },
    get logAction() { return logAction; },
    get markCuriosityStimulus() { return markCuriosityStimulus; },
    get markReadCalledKeys() { return markReadCalledKeys; },
    get mdToPlain() { return mdToPlain; },
    get newBrowseEntry() { return newBrowseEntry; },
    get noKeyToolNames() { return noKeyToolNames; },
    get noteBrowse() { return noteBrowse; },
    get noteSilentTurnEndV2() { return noteSilentTurnEndV2; },
    get noteToolFailure() { return noteToolFailure; },
    get notifyTaskDone() { return notifyTaskDone; },
    get optimizeSkill() { return optimizeSkill; },
    get parseFocusBlock() { return parseFocusBlock; },
    get parseGateReply() { return parseGateReply; },
    get pendingSendToolCalls() { return pendingSendToolCalls; },
    get pendingWakeKeys() { return pendingWakeKeys; },
    get waitToolCalls() { return waitToolCalls; },
    get waitStartAt() { return waitStartAt; },
    get turnWaitMs() { return turnWaitMs; },
    get planSocialTimeline() { return planSocialTimeline; },
    // [C2] 表达策略：mux-bus 只在 debug/开关下消费，不改变默认分条
    get planExpression() { return planExpression; },
    get getMindSelf() { return () => (mindGroundwork ? mindGroundwork.selfState : null); },
    get getMindBelief() { return (k) => mindBeliefFor(k); },
    get recordSessionSnapshot() { return recordSessionSnapshot; },
    get recordSessionUsage() { return recordSessionUsage; },
    get registerPending() { return registerPending; },
    get resolveToolFailure() { return resolveToolFailure; },
    get retireSession() { return retireSession; },
    get retireTaskSession() { return retireTaskSession; },
    get reverse() { return reverse; },
    get rewriteLessons() { return rewriteLessons; },
    get sanitizeToolArgs() { return sanitizeToolArgs; },
    get saveFocusBlock() { return saveFocusBlock; },
    get saveGoals() { return saveGoals; },
    get saveIsolatedDead() { return saveIsolatedDead; },
    get saveLifeFile() { return saveLifeFile; },
    get saveSkills() { return saveSkills; },
    get saveSlang() { return saveSlang; },
    get saveSocialV2State() { return saveSocialV2State; },
    get scheduleNextAtSplit() { return scheduleNextAtSplit; },
    get scheduleTransientArchive() { return scheduleTransientArchive; },
    get scheduleWakeV2() { return scheduleWakeV2; },
    get sendBurstToQQ() { return sendBurstToQQ; },
    get sendGuardCheckV2() { return sendGuardCheckV2; },
    get sendNotice() { return sendNotice; },
    get sendToQQ() { return sendToQQ; },
    get sendToolSucceededSessions() { return sendToolSucceededSessions; },
    get sendWakePromptV2() { return sendWakePromptV2; },
    get setWorkStatus() { return setWorkStatus; },
    get shouldAuditKey() { return shouldAuditKey; },
    get shouldBlockSilentReply() { return shouldBlockSilentReply; },
    get similarThoughtCount() { return similarThoughtCount; },
    get sinkUnsentHint() { return sinkUnsentHint; },
    get slangEntries() { return slangEntries; },
    get slangLearnerSessionId() { return slangLearnerSessionId; },
    get sleep() { return sleep; },
    get social() { return social; },
    get socialState() { return socialState; },
    get startDiarySession() { return startDiarySession; },
    get state() { return state; },
    get stateDataPath() { return stateDataPath; },
    get summarizeWorkerText() { return summarizeWorkerText; },
    get takeExpiredHint() { return takeExpiredHint; },
    get taskCollectors() { return taskCollectors; },
    get taskPoolRunning() { return taskPoolRunning; },
    get taskSessions() { return taskSessions; },
    get thoughtCollectors() { return thoughtCollectors; },
    get thoughtSessions() { return thoughtSessions; },
    get toolCallArgs() { return toolCallArgs; },
    get toolCallNames() { return toolCallNames; },
    get turnDispatch() { return turnDispatch; },
    get turnSeenHeads() { return turnSeenHeads; },
    get turnToolStats() { return turnToolStats; },
    get updateWorkById() { return updateWorkById; },
    get upsertSlangEntry() { return upsertSlangEntry; },
    get v2TurnStartAt() { return v2TurnStartAt; },
    get vision() { return vision; },
    get voteLesson() { return voteLesson; },
    get wakeConfigMissCount() { return wakeConfigMissCount; },
    get wakeConfigUpdatedKeys() { return wakeConfigUpdatedKeys; },
    get wakePriorityV2() { return wakePriorityV2; },
    get workByTaskId() { return workByTaskId; },
  };
  function pumpMux(...args) { return pumpMuxCore(...args, pumpMuxDeps); }
  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  // [ONEBOT-GUARD] 入站闸门：形状校验 + message_id 幂等。默认开；可用
  // snowluma.inboundDedupe.enabled=false 只关去重（形状校验和日志仍保留）。
  const inboundDedupeCfg = cfg.snowluma?.inboundDedupe ?? {};
  const inboundGate = createInboundGate({
    dedupe: inboundDedupeCfg.enabled !== false,
    maxSeen: Number(inboundDedupeCfg.maxSeen) || undefined,
    ttlMs: Number(inboundDedupeCfg.ttlMs) || undefined,
  });
  function rejectInbound(kind, event, result) {
    if (result.reason === 'duplicate') {
      const id = event?.message_id ?? event?.msg_id ?? event?.message_seq ?? '?';
      log(`[dedupe] 忽略重复 ${kind} 消息 id=${id}（${Math.round((result.ageMs ?? 0) / 1000)}s 前已收过）`);
      return;
    }
    log(`[inbound] 忽略畸形 ${kind} 事件：${result.detail || 'unknown'}`);
  }

  // [ONEBOT-HEARTBEAT] 只有真的收到过 heartbeat 才计时；超时主动踢掉旧连接再连。
  let heartbeatReconnectPending = false;
  const heartbeatWatch = createHeartbeatWatch({
    timeoutMs: Number(cfg.snowluma?.heartbeatTimeoutMs ?? 120000),
    isConnected: () => bot.isConnected,
    onTimeout: ({ ageMs, timeoutMs }) => {
      if (heartbeatReconnectPending) return;
      heartbeatReconnectPending = true;
      log(`[heartbeat] ${Math.round(ageMs / 1000)}s 未收到 OneBot 心跳（阈值 ${Math.round(timeoutMs / 1000)}s），主动重连 SnowLuma`);
      try { bot.close(4000, 'heartbeat timeout'); } catch (error) { log(`[heartbeat] 关闭旧连接失败（已忽略）：${error?.message ?? error}`); }
      setTimeout(() => {
        heartbeatReconnectPending = false;
        try {
          bot.connect().catch((error) => log(`[heartbeat] 重连失败（SDK 会继续重试）：${error?.message ?? error}`));
        } catch (error) {
          log(`[heartbeat] 重连异常（已忽略）：${error?.message ?? error}`);
        }
      }, 1000).unref?.();
    },
  });
  oneBotHealth = () => ({
    connected: !!bot.isConnected,
    url: bot.url,
    inbound: inboundGate.stats(),
    heartbeat: heartbeatWatch.stats(),
    queue: outgoing.stats(),
  });

  // [LIFE-MSG] 入站消息落生命线（只记元信息，不记正文）：离线叙事/连续性/社交指标要用。
  // 失败绝不影响消息处理——生命线是观测，不是主链路。
  function noteLifeInbound(kind, id, event) {
    try {
      if (!mindGroundwork) return;
      const key = kind === 'group' ? 'group:' + id : 'private:' + id;
      const raw = typeof event?.raw_message === 'string' ? event.raw_message : '';
      const actorId = event?.user_id ?? event?.sender?.user_id;
      mindGroundwork.lifeLog.append({
        type: 'message.received',
        key,
        actor: 'user:' + String(actorId ?? ''),
        payload: { kind, len: raw.length },
      }, { at: Date.now() });
      // [BELIEF-CONTACT] 只更新熟悉度/最后联系；信任与亲疏留给互动评价。
      if (actorId) mindGroundwork.noteContact(actorId, { key });
      if (kind === 'group') mindGroundwork.noteGroupActivity(key, { source: 'message' });
    } catch { /* 观测失败忽略 */ }
  }

  bot.onPrivateMessage(async (event) => {
    if (event.post_type === 'message_sent') return; // 自己发出的回显，不是入站消息
    if (event.user_id === event.self_id) return;
    heartbeatWatch.noteActivity(); // 有入站事件 = 连接不是"开着但不通"
    let gate;
    try { gate = inboundGate.accept(event); } catch (error) { log('入站闸门异常（私聊）:', error?.stack || error); return; }
    if (!gate.ok) { rejectInbound('私聊', event, gate); return; }
    noteLifeInbound('private', event.user_id, event);
    // [LIFE-SENSE] 只镜像进内核 sense；旧消息路径完全不变。
    if (lifeSenseHolder.current && typeof lifeSenseHolder.current.push === 'function') { try { lifeSenseHolder.current.push({ type: 'message.received', payload: { key: convKey('private', event.user_id) }, at: Date.now() }); } catch { /* best-effort */ } }
    // [M3] 同一会话的消息挂到该会话的 mailbox 串行消费，杜绝同会话并发处理的状态竞态；
    // 不同会话各自 mailbox 独立 → 并行。前置处理（语音转写/转发预读/social 读写）+ 末尾 DSH
    // 投递现在全程串行，行为比「仅末尾串行」更确定。
    try { await mailboxEnqueue(convKey('private', event.user_id), () => handleIncoming('private', event.user_id, event, cfg)); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.post_type === 'message_sent') return; // 自己发出的回显，不是入站消息
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    heartbeatWatch.noteActivity(); // 有入站事件 = 连接不是"开着但不通"
    let gate;
    try { gate = inboundGate.accept(event); } catch (error) { log('入站闸门异常（群）:', error?.stack || error); return; }
    if (!gate.ok) { rejectInbound('群', event, gate); return; }
    noteLifeInbound('group', event.group_id, event);
    if (lifeSenseHolder.current && typeof lifeSenseHolder.current.push === 'function') { try { lifeSenseHolder.current.push({ type: 'message.received', payload: { key: convKey('group', event.group_id) }, at: Date.now() }); } catch { /* best-effort */ } }
    // [M3] 同群消息挂到该群 mailbox 串行消费；不同群各自并行。
    try { await mailboxEnqueue(convKey('group', event.group_id), () => handleIncoming('group', event.group_id, event, cfg)); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onMetaEvent((event) => {
    if (event?.meta_event_type === 'heartbeat') {
      heartbeatWatch.noteHeartbeat(event.interval);
      // 心跳本身就是 SnowLuma 活着的证据：同步刷新看护时间，避免把“活着但 WS 假死”
      // 误判成“SnowLuma 进程没了”而重复拉起。wsLastOkAt 在下方声明，连接前不会触发。
      snowLumaNoteHeartbeat();
    }
  });
  // [ONEBOT-GUARD] poke notice 也走同一张幂等表：重连/重放时同一个拍一拍只处理一次。
  bot.onNotice('notify', async (event) => {
    const dedupeKey = pokeDedupeKey(event);
    if (dedupeKey) {
      const gate = inboundGate.acceptKey(dedupeKey);
      if (!gate.ok) {
        const sender = event?.sender_id ?? event?.user_id ?? '?';
        const target = event?.target_id ?? '?';
        log(`[dedupe] 忽略重复拍一拍 ${sender} -> ${target}`);
        return;
      }
    }
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // [STICKER-RESYNC] 启动预热（下方 syncStickerLibrary(true)）必然输给 SnowLuma WS 连接竞态：
  // 预热在「已启动」后 1 秒内执行，WS 还没连好 → 失败且无重试 → 表情库停在旧状态（实测今晚 16 次重启=16 次失败）。
  // 补偿：WS 连接成功后若本 boot 表情库仍未同步成功 → 补一次（幂等：成功即停；重连风暴 60s 冷却）。
  let stickerResyncAt = 0;
  function stickerResyncAfterOpen() { return stickerPool.stickerResyncAfterOpen(); }
  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    log(`SnowLuma 已连接：${connectedUrl}`);
    snowLumaNoteOpen();
    heartbeatWatch.noteOpen(); // 开"首事件"观察窗：连上但 3 分钟一条事件都没有 → 踢掉重连
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
    }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/app.mjs:5355'));
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
    // [STICKER-RESYNC] WS 就绪后补偿表情库同步（预热竞态兜底）
    stickerResyncAfterOpen();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  // SnowLuma token 自愈已搬到 snowluma-token-service.mjs（P3-RW-44）。
  const snowLumaToken = createSnowLumaToken({
    cfg,
    bot,
    path,
    ROOT,
    log,
    persistSnowLumaEndpoint,
    persistToken,
    discoverSnowLumaConnection,
  });
  const { applyHealedTokens, syncTokenToFile, healTokenIfStale } = snowLumaToken;


  // [SNOWLUMA-WATCHDOG] 网关静默看护已搬到 snowluma-watchdog-service.mjs（P3-RW-62）。
  const snowLumaWatchdog = createSnowLumaWatchdog({ fs, path, __dirname, spawn, log });
  function watchdogSnowLuma(reason) { return snowLumaWatchdog.watchdogSnowLuma(reason); }
  function snowLumaNoteOpen() { return snowLumaWatchdog.noteOpen(); }
  function snowLumaNoteHeartbeat() { return snowLumaWatchdog.noteHeartbeat(); }
  function snowLumaNoteClose() { return snowLumaWatchdog.noteClose(); }


  bot.on('close', (info) => {
    const wsStreakNow = snowLumaNoteClose();
    // 断线期间不判心跳超时：SDK 正在重连，重置后等下一次心跳重新起算。
    heartbeatWatch.reset();
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…（连续 ${wsStreakNow} 次）`);
    if (wsStreakNow >= 8) watchdogSnowLuma(`连续 ${wsStreakNow} 次断开`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error?.stack || error?.message || error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    log(`SnowLuma 初始连接失败（将在后台自动重连）: ${error?.message ?? error}`);
  });
  // [TOKEN-PROACTIVE] 首次启动也可能“连上了但 token 是 HTTP 的、WS 事件全丢”：
  // 主动自愈一次，把 bot.accessToken 换成当前账号的 WS token；失败不阻塞。
  setTimeout(() => { void healTokenIfStale('startup'); }, 3000);
  heartbeatWatch.start();
  {
    const inboundStats = inboundGate.stats();
    const hbStats = heartbeatWatch.stats();
    log(`[OneBot] 入站去重=${inboundDedupeCfg.enabled === false ? '关' : `开(ttl ${Math.round((inboundStats.ttlMs || 0) / 1000)}s, max ${inboundStats.maxSeen})`} · 心跳超时=${hbStats.effectiveTimeoutMs ? `${Math.round(hbStats.effectiveTimeoutMs / 1000)}s` : '关'}`);
  }
  log('桥接已启动。按 Ctrl+C 退出。');
  // [LOCAL-3B] 已有 3B 按需起、闲置自动退（参照 llama-swap 的 ttl 思路）
  try { startLocal3bSweeper(cfg, log); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:12660'); }
  // [CONCURRENCY-LOG] 实际生效的并发上限（配置改没改、进程重启没有，一眼可查）
  try { log(`[gate] 最大并发 turn = ${maxConcurrentTurns()}（config: dsh.maxConcurrentTurns）`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:12662'); }
  // [PEOPLE] 全局人物索引：启动时对齐一次（跨群归一 + 她的持久印象之家）；平时由 noteMember 增量维护
  try { peopleIndex.rebuild(); } catch (error) { log('人物索引重建失败:', error?.message ?? error); }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startConsoleServer();
  // [RESUME] 重启续命：60s 后把落盘的 ownlife 队列派出去；30s 后把没跑完的活重新排队
  setTimeout(() => { try { drainOwnlifeQueue(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'app.mjs:12672'); } }, 60000).unref?.();
  // [WORKS-RESUME] 重启续命：轮询直到 DSH 就绪再恢复（一次性 30s 会漏；最多等 20 分钟）
  (() => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (!dshReady) {
        if (tries > 40) { clearInterval(t); log('[works] 重启恢复：DSH 长时间未就绪，放弃本次恢复'); }
        return;
      }
      clearInterval(t);
      void reconcileWorksOnBoot().catch((e) => globalThis.__ignoredCatch?.(e, 'src/app.mjs:5448'));
      void ensureHerWorkspace().then((id) => log(`[her-workspace] 统一工作区就绪：${id.slice(0, 8)}（${String(cfg.workspaceTitle || 'QQ 聊天')}）`)).catch((error) => log(`[her-workspace] 工作区初始化失败（已忽略）：${error?.message ?? error}`));
      void pruneMissingSessions().catch((e) => globalThis.__ignoredCatch?.(e, 'src/app.mjs:5450'));
      // [SESSION-RETAIN] DSH 就绪后跑一轮：清已归档旧目录 + 归档长期闲置会话
      void maintenance.runSessionRetain().catch((e) => globalThis.__ignoredCatch?.(e, 'src/app.mjs:5452'));
      try { restoreTransientArchives(); } catch (error) { log(`[transient-archive] 恢复失败（已忽略）：${error?.message ?? error}`); }
    }, 30000);
    t.unref?.();
  })();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
/**
 * [SINGLE-FATAL-POLICY] 致命策略统一由 crash-forensics.js（--import 预加载）持有。
 * 旧实现这里又注册了 unhandledRejection（只打 stack）与 uncaughtException（saveState 后 exit），
 * 两套策略并存且互相打架：取证模块先注册并直接 exit(1)，下面这段 saveState() 根本跑不到。
 * 现在只注入"退出前要做的事"，由取证模块保证在退出前调用；不再注册任何致命监听器。
 *
 * 背景：`log()` 从 SnowLuma SDK 的 socket 回调调用，stdout 读者消失时 console.log 会抛 EPIPE，
 * 穿过 log() → 监听器 → emit → socket 回调变成 uncaughtException。没有兜底就会每 5 秒崩一次。
 */
if (typeof globalThis.__setCrashBeforeFatal === 'function') {
  globalThis.__setCrashBeforeFatal((kind, error) => {
    // [SMOKE] 冒烟测试进程：顶层炸弹（裸标识符）直接退出 1，不碰状态文件。
    if (process.env.BRIDGE_SMOKE_TEST === '1') {
      try { console.error('[bridge] SMOKE_FAIL:', error?.stack ?? error?.message ?? error); } catch (e) { void e; }
      return;
    }
    try { log(`致命异常（${kind}，进程即将退出）:`, error?.stack ?? error?.message ?? error); } catch (e) { void e; }
    try { saveState(); } catch (e) { void e; }
    releaseLock();
  });
}
process.on('exit', () => releaseLock());

export { main };

