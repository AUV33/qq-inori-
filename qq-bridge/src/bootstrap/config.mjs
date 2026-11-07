// 配置加载与归一：config.json -> 运行时 cfg（默认值/白名单/人格/社交/工具）。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。纯对象归一，不碰运行态；
// root 由调用方传入，默认值来自各领域模块。
import path from 'node:path';
import { readJsonSafe } from './fs-utils.mjs';
import { RETENTION_DEFAULTS } from '../domain/leaves/inori-session-retain.js';
import { GATE_DEFAULTS } from '../domain/leaves/inori-gate.js';
import { ROLE_INJECT_MAX_CHARS_DEFAULT, applyRoleInjectLimit } from '../domain/persona/role-preset-store.mjs';
import { SOCIAL_V2_TOOLS_DEFAULTS } from '../domain/shared/tool-flags.js';
import { mergeSocialV2Defaults } from '../domain/shared/config-merge.js';
import { findDroppedKeys } from '../config-check.mjs';
import { validateSocialV2Config } from '../domain/shared/config-schema.js';
import { discoverDshLaunchToken } from '../adapters/dsh-client.js';
// [WIRING-FIX] 外提时漏了这两个符号：normalizeReasoningEffort 未定义 → 每次启动 ReferenceError
// 被 catch 吞掉后强制回退 max，config.json 里的 low/high 永远不生效。
import { normalizeReasoningEffort, REASONING_EFFORT_DEFAULT } from './text-utils.mjs';

let rawConfigFile = null;

export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// [CONFIG-SECURITY-FIX] 安全关键字段名拼错（如 consoleToken→consoleTokn、ownerQQ→ownerQq）
// 会被白名单加载器静默丢弃，进而 fail-open（空令牌启动 / "我配了 deny"实际没配）。
// 这里用编辑距离 ≤1 识别"拼写近似的安全键"，让这类 typo 也 fail-closed，逼用户修正。
// 只对这三个独特长键做近似匹配，避免 deny/allow/security 这类短词误报。
const SECURITY_KEY_TYPOS = ['ownerQQ', 'consoleToken', 'consolePort'];
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
function isSecurityKeyTypo(path) {
  const top = String(path).split('.')[0];
  if (SECURITY_KEY_TYPOS.includes(top)) return false; // 精确命中由主逻辑处理
  return SECURITY_KEY_TYPOS.some((k) => levenshtein(top, k) <= 1);
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
// [OPT] socialV2.tools 默认开关的**唯一来源**（之前有两份并集表，2026-10-25 审计发现已漂移）。
// 缺键 = v2ToolEnabled 视为开启；显式 false 才是关闭。

export function loadConfig({ root, log }) {
  const p = path.join(root, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  rawConfigFile = file;
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // [AUDIT-FIX] host-action-policy.js 与 console-server.mjs 都会读这个键，
    // 但白名单式 loadConfig 一直没拷贝它，配置写了也不生效。
    hostActionAllow: Array.isArray(file.hostActionAllow)
      ? file.hostActionAllow.map((v) => String(v).trim()).filter(Boolean)
      : [],
    // [SESSION-RETAIN] 会话目录保留策略：DSH 没有删会话 API，archiveSession 只隐藏，
    // 桥接又不断新建（任务一任务一会话、临时会话用完即归档）→ 会话目录只增不减。
    // 默认：已归档的聊天会话留 7 天、临时 kind 留 1 天；未归档但闲置 24h 的会话自动归档。
    sessionRetain: {
      enabled: true,
      days: RETENTION_DEFAULTS.days,
      ephemeralDays: RETENTION_DEFAULTS.ephemeralDays,
      archiveStaleHours: RETENTION_DEFAULTS.archiveStaleHours,
      orphanEnabled: true,
      orphanDays: RETENTION_DEFAULTS.orphanDays,
      maxOrphanDelete: RETENTION_DEFAULTS.maxOrphanDelete,
      intervalHours: 12,
      ...(file.sessionRetain ?? {})
    },
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    // [P2] 调度治理四段：原样透传；缺省时由调度/资源门/日闸各自用安全默认
    //（后台 6 次/时、资源门观察模式、日闸 40 元），不要在别处再写一份默认值。
    background: { ...(file.background ?? {}) },
    turnPriority: { ...(file.turnPriority ?? {}) },
    resources: { ...(file.resources ?? {}) },
    tokenLedger: { ...(file.tokenLedger ?? {}) },
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: false, // [Q2] 一代仿真默认关闭：reserved2 是唯一自主系统；若确需一代状态机，设 mode=reserved 并改回 true
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    // [OWN-LIFE] 必须显式拷贝：这个加载器是白名单式的，不拷就等于运行时永远拿到 {}
    //（踩过：config.json 里写了 ownLife.maxPerDay=12，日志却一直打 6，因为 cfg.ownLife 是 undefined）
    ownLife: { ...(file.ownLife ?? {}) },
    // [VIDEO] B 开关：关=默认几帧；开=全片抽帧 + 逐段理解要求。白名单式加载器必须显式拷贝。
    video: { fullUnderstand: false, ...(file.video ?? {}) },
    // [WIRING-FIX] 2026-11-03：同一个白名单坑，这两段一直没被拷贝 ⇒ 两个开关是死的：
    //   · floor.adaptive：wake-schedule.mjs 用它决定"自适应睡眠阈值"，读不到 ⇒ 恒 true（关不掉）；
    //   · phone.adb：inori-phone-availability.js 用它定位 adb，读不到 ⇒ 只能靠环境变量/默认路径。
    // config.example.json 里这两段都写着，启动时还会被 config-check 报成「未被加载器识别」。
    floor: { judgeWake: true, judgeWakeConf: 0.5, ...(file.floor ?? {}) },
    phone: { ...(file.phone ?? {}) },
    // [QUANT] 同款白名单坑：不显式拷贝，cfg.quant 永远是 {}，quant.enabled 永远读不到。
    quant: { ...(file.quant ?? {}) },
    // [IMAGEGEN] 同一个白名单坑（2026-10-30 审计实测：config.json 的 imagegen 每次启动都被
    // 报「未被加载器识别」，createImageGen 一直拿空对象走默认值）。必须显式透传。
    imagegen: { ...(file.imagegen ?? {}) },
    // [GATE] 白名单同款坑（见 ownLife 注释）：gate 段必须显式拷贝，否则 cfgRef?.gate 永远是 {}、
    // cosThreshold 一直回退 GATE_DEFAULTS 的 0.6，config.json 里改 0.55 也不生效。
    // 以 GATE_DEFAULTS 为底、config.json 的 gate 段覆盖（缺字段仍有默认兜底）。
    gate: { ...GATE_DEFAULTS, ...(file.gate ?? {}) },
    // [LIFE] 宪章 S4：生命内核唯一开关（旧的 kernel.shadow 旋钮已移除）运行模式（off=不跑 / shadow=只推演不接管 / drive=接管）。
    // drive 在真实端口接好前与 shadow 同行为（仍只 tick、不写旧状态），日志会明确标注。
    life: {
      // 默认 off：生命内核默认不跑（与 config.example.json + 纪律契约一致，零行为变更）。
      // 需要影子/接管时在 config.json 显式写 life.mode = "shadow" | "drive"。
      mode: 'off',
      reflectMs: 6 * 3600 * 1000,
      reflectWindowMs: 24 * 3600 * 1000,
      goalStaleMs: 14 * 24 * 3600 * 1000,
      reconcileScale: 1,
      ...(file.life ?? {}),
    },
    socialV2: mergeSocialV2Defaults({
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: { ...SOCIAL_V2_TOOLS_DEFAULTS },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 旧开关：收尾前先看完未读的检查（名字保留兼容，语义已不是观察窗）
        preSleepWaitMs: 300000,          // [已废弃] 静默窗口阈值；收尾不再按时间判断，保留字段只为旧配置能读
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '要不要潜水看你自己判断：这个话题跟你没关系、你也插不上话，就可以收尾——不用等安静，也不用等谁说完。唯一前提是把最新消息看完（快照 partial=true 或提示还有未展示未读，就先 qq_get_unread_messages(afterSeq=readThroughSeq) 补齐），看完觉得没你的事，直接 qq_mark_read(throughSeq=...) 或 qq_set_wake_config(config=..., throughSeq=...) 收尾；想接就接。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 5000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000,  // 收尾观察（purpose=messages）的最小静默；reply 已不受它限制
        replyDebounceMs: 2000       // [W-1/P4] 首回复只等"合并连发"这么久，不再等场子安静
      },
      // [SECRETARY] 非定向唤醒（概率/续聊/问到/提到她）先过一道语义门：
      // 用本地 3B（免费、已有）判「这条是在跟她说吗、她此刻接合不合适」，判不了就放行。
      secretary: {
        enabled: true,
        timeoutMs: 5000,
        maxTokens: 96,
        recentLimit: 8,
        msgChars: 80,
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
    }, file.socialV2)
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = { ...SOCIAL_V2_TOOLS_DEFAULTS, ...(cfg.socialV2.tools ?? {}) };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  const roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  // [CONFIG-CHECK] loadConfig 是白名单式的：config.json 里拼错/未接线的键会被静默丢弃，
  // 不会报错也不会生效（Mizuse 项目踩过同类：pcfg/cfg 读错层，三个开关永远是默认值）。
  // 这里拿「合并后的 cfg」当权威形状比对原始文件。
  try {
    const dropped = findDroppedKeys(file, cfg);
    if (dropped.length) {
      log(`⚠️ config.json 有 ${dropped.length} 个键未被加载器识别（写错名或尚未接线，不会生效）：${dropped.map((d) => d.path).join(', ')}`);
      // [F13] 安全相关段（deny/allow/security/ownerQQ/consoleToken/consolePort）写错键名
      // 不能静默失败开放：例如把 deny 拼错、把 consoleToken 写成 consoleTken，会让
      // 「我配了拒绝/鉴权」实际变成「全部放行/空令牌」。这些段的未知键一律拒绝启动
      // （fail-closed），逼用户在 config.json 里修正，而不是悄悄退回默认值。
      const securityPaths = dropped.filter((d) =>
        /^(deny|allow|security)(\.|$)/.test(d.path) ||
        d.path === 'ownerQQ' || d.path === 'consoleToken' || d.path === 'consolePort' ||
        isSecurityKeyTypo(d.path)
      );
      if (securityPaths.length) {
        throw new Error(`配置安全段存在未识别键，拒绝启动（fail-closed）：${securityPaths.map((d) => d.path).join(', ')}。请参考 config.example.json 修正键名。`);
      }
    }
  } catch (error) {
    if (error?.message?.startsWith('配置安全段存在未识别键')) throw error; // 安全段不放行
    log(`[config-check] 体检跳过（不影响启动）：${error?.message ?? error}`);
  }

  const socialCheck = validateSocialV2Config(cfg.socialV2);
  if (!socialCheck.ok) {
    console.error(`[config] socialV2 类型异常（不会阻断启动，但请修 config.json）：${socialCheck.errors.join('；')}`);
  }
  // [CONFIG-SECURITY] 安全字段写错类型/键名不能静默回默认（否则"我配了 deny"其实没配）。
  // 这里只做高可见度告警、不挡启动：24/7 进程被一个 typo 卡死比降级更糟。
  const secIssues = [];
  if (file.ownerQQ !== undefined && !/^\d+$/.test(String(file.ownerQQ ?? '').trim())) {
    secIssues.push('ownerQQ 必须是纯数字 QQ 号');
  }
  for (const key of ['allow', 'deny']) {
    if (file[key] !== undefined && (typeof file[key] !== 'object' || Array.isArray(file[key]) || file[key] === null)) {
      secIssues.push(`${key} 必须是对象（{private:[],groups:[]}），实际 ${Array.isArray(file[key]) ? 'array' : typeof file[key]}`);
    }
  }
  if (file.allowAllWhenEmpty !== undefined && typeof file.allowAllWhenEmpty !== 'boolean') {
    secIssues.push(`allowAllWhenEmpty 必须是 boolean，实际 ${typeof file.allowAllWhenEmpty}`);
  }
  if (file.consolePort !== undefined && (!Number.isInteger(Number(file.consolePort)) || Number(file.consolePort) <= 0 || Number(file.consolePort) > 65535)) {
    secIssues.push(`consolePort 必须是 1-65535 的整数，实际 ${String(file.consolePort)}`);
  }
  if (file.consoleToken !== undefined && typeof file.consoleToken !== 'string') {
    secIssues.push('consoleToken 必须是字符串');
  }
  if (secIssues.length) {
    log(`⛔ [config-security] 安全相关配置有 ${secIssues.length} 处类型错误（不会阻断启动，但对应策略会退回默认值）：${secIssues.join('；')}`);
  }
  return { cfg, raw: rawConfigFile, roleInjectMaxChars };
}
