import { readBridgeSource } from './lib/bridge-source.mjs';
// 回归锁：socialV2 会话状态 保存=全量序列化（剔除瞬态）、加载=未知字段直通。
//
// 背景（2026-10-25 审计）：saveSocialV2State 曾是固定字段白名单——groupFeedback / chase /
// echoState / lastPromptSeq / pendingWakeReasons / groupHabits 等字段写进内存后落不了盘，
// 每次重启全部清零：「她的群被接率累计、追问计数、复读状态、读水位」全丢，
// 群反馈自适应（computeProactivity 的 rate）在跨重启窗口内恒回退默认 0.5。
// 修法：save 改全量 spread（新增字段自动跟随），只显式剔除四个瞬态定时器；
// load 对磁盘上的未知字段直通（st 已有字段仍走类型化重建，互不干扰）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readBridgeSource();

// save 侧：全量 spread + 瞬态剔除
const saveStart = src.lastIndexOf('function saveSocialV2State()');
assert.ok(saveStart > 0, '定位 saveSocialV2State');
const saveBody = src.slice(saveStart, saveStart + 2200);
assert.ok(/\{ \.\.\.st \}/.test(saveBody), 'save 必须全量 spread 会话状态（新增字段自动跟随）');
const transientList = saveBody.match(/for \(const transient of \[([^\]]+)\]\)/)?.[1] ?? '';
for (const t of ['sleepTimer', 'replyCheckTimer', 'pendingWakeTimer', 'proactiveTimer']) {
  assert.ok(transientList.includes(t), `save 必须剔除瞬态定时器 ${t}`);
}

// load 侧：未知字段直通
const loadMarker = '[STATE-WHITELIST-FIX] 未知字段直通';
assert.ok(src.includes(loadMarker), 'load 侧必须有未知字段直通（防 save/load 白名单再次不同步漂移）');
const pass = src.slice(src.indexOf(loadMarker), src.indexOf(loadMarker) + 400);
assert.ok(/for \(const \[fk, fv\] of Object\.entries\(val\)\)/.test(pass), '直通必须是遍历磁盘 val 的字段');
assert.ok(/fk in st/.test(pass), '已有字段（类型化重建过的）不许被直通覆盖');

// [GROUP-FB-WINDOW] 群反馈 24h 滚动窗：写端两处（sent 记账 / replied 记账）都要有 rollover，
// 且注入层与 proactivity 必须共用同一个取数口径 groupFeedbackRate（不许各读各的）
const rateFn = src.lastIndexOf('function groupFeedbackRate(');
assert.ok(rateFn > 0, '必须存在统一取数助手 groupFeedbackRate');
const rateBody = src.slice(rateFn, rateFn + 700);
assert.ok(/24 \* 3600000/.test(rateBody), '口径必须含 24h 过期判断');
assert.ok(src.includes('[GROUP-FB-WINDOW] 24h 滚动窗：过窗清零重计（累计值不许稀释近期行为）'), 'sent 记账端必须有窗口 rollover');
assert.ok(/if \(Date\.now\(\) - Number\(gf\.windowStart \|\| 0\) > 24 \* 3600000\) \{\s*gf\.sent = 0; gf\.replied = 0;/.test(src), 'replied 记账端必须有窗口 rollover');
assert.ok(/const rate = groupFeedbackRate\(st, now\) \?\? 0\.5/.test(src), 'proactivity 必须走统一口径（缺样本兜 0.5 中性）');
assert.ok(/const gfRate = groupFeedbackRate\(stG\)/.test(src), '注入层必须走统一口径');

// [BUSY-CAP] 看门狗必须有任何 busy 组合的硬上限（2026-10-25 实测：123456789 卡 45+ 分钟，
// 两条静默 continue 路径——sid 缺失 / DSH running 恒 true——让 busy 永不清除）
assert.ok(src.includes('busySinceMs'), '必须存在 busy 计时 Map');
assert.ok(/\[BUSY-CAP\] 任何 busy 组合的硬上限/.test(src), '看门狗必须有 [BUSY-CAP] 硬上限分支');
const capBody = src.slice(src.indexOf('[BUSY-CAP] 任何 busy 组合的硬上限'), src.indexOf('[BUSY-CAP] 任何 busy 组合的硬上限') + 3000);
assert.ok(/busyCapMs/.test(capBody), '上限必须可配置（cfg.socialV2.wake.busyCapMs）且有 10min 下限');
assert.ok(/pendingWakeKeys\.delete\(key\)/.test(capBody), '超限时必须清 pendingWakeKeys');
assert.ok(/qe\.running = false/.test(capBody), '超限时必须清 promptQueues 的 running');
assert.ok(/scheduleWakeV2\(key, best\)/.test(capBody), '超限释放后必须补发暂存的最高优先级唤醒');
// 三处清理点（stale-turn / 工作区清空 / DSH 重连）必须同步清计时，否则重启 DSH 后计时器过时
assert.ok(((src.match(/busySinceMs\.clear\(\)/g) || []).length) >= 3, 'stale-turn/清空/重连三处清理点必须清 busySinceMs');

// [NO-SEND-CLEANUP] noSendHint 过期必须清理（潜水模式下 10min 窗口外的唤醒永远不会消费它，
// 旧代码 hint 残留 state 永不清除）。2026-10-25 晚后续会话把「过期即遗忘」升级成
// 「过期沉底（unsent 容器）」——两种形态都必须真的把 st.noSendHint 删掉，不许残留。
const noSendBlock = src.slice(src.indexOf('[NO-SEND] 上一轮只写了文字没发出去'));
assert.ok(/delete stNS\.noSendHint/.test(noSendBlock), 'noSendHint 过期必须删除（NO-SEND-CLEANUP 分支）');
assert.ok(/sinkUnsentHint\(/.test(noSendBlock) || /\[NO-SEND-CLEANUP\]/.test(noSendBlock), '过期分支要么沉底要么直接清理，不能留着');
// 写入点日志措辞必须对齐真实规则（旧日志承诺「下次唤醒提醒补发」，潜水模式下永远不会发生）
assert.ok(/10 分钟内下次唤醒才注入补发提醒/.test(src), 'no-send 日志措辞必须说明 10min 窗口真实规则');

console.log('social-v2 状态持久化回归锁通过：全量 spread + 瞬态剔除 + 未知字段直通 + 群反馈 24h 窗口 + BUSY-CAP 硬上限 + noSendHint 过期清理');
