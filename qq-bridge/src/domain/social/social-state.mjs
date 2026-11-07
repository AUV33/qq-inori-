// 社交状态核心：get/load/save、唤醒安全、未发话沉底。
//
// 从 app.mjs 的 main() 搬出（P3-RW-14，2026-10-31）。socialV2 / seenForwardIds 是 app 持有的
// 同一实例；本模块只负责状态的读写与规范化，不创建定时器（只调用注入的 schedule/setup）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
// [SHARD-AUDIT] M1：per-key 分片写入复用 state-store 同款的跨进程锁（已在双进程压测下验证）。
import { withFileLock } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

/**
 * @param {object} ctx
 * @param {object} ctx.socialV2
 * @param {Map<string,Set<string>>} ctx.seenForwardIds
 * @param {string} ctx.socialFile
 * @param {(...args:any[])=>void} ctx.log
 * @param {(file:string,fallback:any)=>any} ctx.readJsonSafe
 * @param {(file:string,obj:any)=>void} ctx.atomicWriteJson
 * @param {()=>object} ctx.defaultWakeConfigV2
 * @param {(st:object)=>void} ctx.refreshDefaultWakeConfigV2
 * @param {(value:any)=>string[]} ctx.normalizeSpeakerIdsV2
 * @param {(key:string)=>string} ctx.canonicalV2Key
 * @param {(key:string,token:string)=>void} ctx.rememberAgentToken
 * @param {(id:any)=>string} ctx.sanitizeForwardId
 * @param {(key:string)=>void} ctx.scheduleProactiveCheckV2
 * @param {(key:string)=>void} ctx.setupSleepTimerV2
 * @param {(hint:any,now:number)=>any} ctx.takeExpiredHint
 * @param {(text:string,at:number,key:string)=>void} ctx.sinkUnsentHint
 */
export function createSocialState({
  socialV2, seenForwardIds, socialFile, log, readJsonSafe, atomicWriteJson,
  defaultWakeConfigV2, refreshDefaultWakeConfigV2, normalizeSpeakerIdsV2,
  canonicalV2Key, rememberAgentToken, sanitizeForwardId,
  scheduleProactiveCheckV2, setupSleepTimerV2, takeExpiredHint, sinkUnsentHint,
}) {
  // [SHARD-AUDIT] M1 分片基础设施：每个会话独立文件 + 独立跨进程锁。
  // 不同群/私聊的落盘走向不同文件，不再抢同一把锁，单文件热点与
  // 「全量重写覆盖他进程更新」的隐患同时消除（对应并发模型设计文档 M1）。
  const SHARD_DIR = path.join(path.dirname(socialFile), 'social-v2.shards');
  const META_FILE = path.join(SHARD_DIR, '_meta.json');
  // key → 上次落盘的序列化内容；用于「只写脏分片」，避免每次全量重写所有会话。
  const lastSaved = new Map();
  // [SHARD-AUDIT] M2：任务态/关系态分离。任务态是快变、任务级的（未竟之事、节流计时、
  // 去重键、读水位等）；关系态（她的感受、唤醒配置、挂心事、话题、对这人的记忆）留在主分片。
  // 物理分离成两个文件 → 不同锁 → 互不影响：一个会话的「正在做的事」损坏不会污染「对这人的感觉」。
  const TASK_FIELDS = [
    'lastHandoff', 'lastTaskDone', 'noSendHint', 'chunkDedupKeys',
    'wakeTimes', 'sendTimes', 'stickerCollectTimes', 'modelSeenSeqs',
    'lastUnreadSeq', 'lastReadThroughSeq', 'lastAiReplyAt', 'lastActionAt', 'lastIncomingAt',
    'preSleepWaitSatisfiedAt', 'preSleepWaitObservedAt', 'preSleepWaitAccumMs',
  ];
  const taskFile = (key) => path.join(SHARD_DIR, `${safeShardName(key)}__task.json`);
  const lastSavedTask = new Map();
  // key 形如 group:123 / private:456，Windows 文件名禁用 ':'，统一替换为 '_'。
  const safeShardName = (key) => String(canonicalV2Key(key) || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  const shardFile = (key) => path.join(SHARD_DIR, `${safeShardName(key)}.json`);
  function withShardLock(file, fn) {
    const r = withFileLock(file, fn);
    // withFileLock 拿不到锁时返回 {ok:false} 而非抛错；不转换会被当成"写成功"。
    if (r && typeof r === 'object' && r.ok === false && typeof r.error === 'string') {
      throw new Error(`social-state: 分片锁失败 ${path.basename(file)}: ${r.error}`);
    }
    return r;
  }
  function serializeConversation(key, st) {
    const saved = { ...st };
    for (const transient of ['sleepTimer', 'replyCheckTimer', 'pendingWakeTimer', 'proactiveTimer']) delete saved[transient];
    // [SHARD-AUDIT] M2：任务态字段拆到独立 task 分片，主分片只留关系态。
    for (const f of TASK_FIELDS) delete saved[f];
    for (const [f, cap] of [['recentMessages', 200], ['unread', 100], ['wakeTimes', 200], ['sendTimes', 500], ['stickerCollectTimes', 500], ['activeTopics', 50], ['pendingThoughts', 50]]) {
      if (Array.isArray(saved[f]) && saved[f].length > cap) saved[f] = saved[f].slice(-cap);
    }
    saved.seenForwardIds = Array.from(seenForwardIds.get(key) || []).slice(-1000);
    // 分片文件必须内嵌 key：文件名经 sanitize 不可逆，加载时只能靠内容里的 key 还原。
    saved.key = key;
    return saved;
  }
  function serializeTaskState(key, st) {
    const caps = { wakeTimes: 200, sendTimes: 500, stickerCollectTimes: 500 };
    const task = { key };
    for (const f of TASK_FIELDS) {
      if (st[f] === undefined) continue;
      let v = st[f];
      const cap = caps[f];
      if (cap && Array.isArray(v) && v.length > cap) v = v.slice(-cap);
      task[f] = v;
    }
    return task;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // [SHARD-AUDIT] M1：社交状态从「单文件全量序列化」改为「per-key 分片」。
      // 每个会话独立文件 + 独立跨进程锁，不同群/私聊的落盘不再互相阻塞，
      // 单文件热点与「全量重写覆盖他进程更新」的隐患同时消除。
      let conversationsRaw = null;
      let fileStamp = null;
      const useShard = fs.existsSync(SHARD_DIR);
      if (useShard) {
        try { socialV2.paused = !!readJsonSafe(META_FILE, null)?.paused; } catch { /* best-effort */ }
        conversationsRaw = {};
        for (const f of fs.readdirSync(SHARD_DIR)) {
          if (!f.endsWith('.json') || f === '_meta.json' || f.endsWith('__task.json')) continue;
          const full = path.join(SHARD_DIR, f);
          const val = readJsonSafe(full, null);
          if (val && val.key && /^(group|private):\d+$/.test(val.key)) {
            // [SHARD-AUDIT] M2：合并同名 task 分片（任务态）回主分片，重建完整会话。
            const taskVal = readJsonSafe(full.replace(/\.json$/, '__task.json'), null);
            if (taskVal && typeof taskVal === 'object') {
              for (const tf of TASK_FIELDS) if (taskVal[tf] !== undefined) val[tf] = taskVal[tf];
            }
            conversationsRaw[val.key] = val;
          }
        }
      } else if (fs.existsSync(socialFile)) {
        // 一次性迁移：旧单文件存在且分片目录还没有 → 拆成 per-key 分片，并保留旧文件备份。
        const raw = readJsonSafe(socialFile, null);
        if (raw && typeof raw.conversations === 'object') {
          // [SHARD-AUDIT] 并发启动下只让「第一个创建分片目录」的实例负责拆分，
          // 其余实例看到 SHARD_DIR 已存在就直接走 useShard 加载，避免两个实例都去写
          // 0 占位、再互相覆盖对方已经写好的分片（这会偶发把最终值打回 0）。
          let created = false;
          try { fs.mkdirSync(SHARD_DIR); created = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
          if (created) {
            let n = 0;
            for (const [k, v] of Object.entries(raw.conversations)) {
              if (!v || typeof v !== 'object' || !/^(group|private):\d+$/.test(k)) continue;
              try {
                // [SHARD-AUDIT] M2：迁移也按「关系态 / 任务态」拆成两个分片。
                const rel = { ...v }; for (const f of TASK_FIELDS) delete rel[f]; rel.key = k;
                const task = { key: k }; for (const f of TASK_FIELDS) if (v[f] !== undefined) task[f] = v[f];
                atomicWriteJson(shardFile(k), rel);
                atomicWriteJson(taskFile(k), task);
                n++;
              } catch { /* best-effort */ }
            }
            if (raw.paused) atomicWriteJson(META_FILE, { paused: true, version: 1 });
            try { fs.renameSync(socialFile, socialFile + '.migrated'); } catch { /* best-effort */ }
            log(`[migrate] ${n} 个会话已从单文件迁到分片目录（旧文件备份为 ${path.basename(socialFile)}.migrated）`);
          }
          // 迁移后立即从分片重新加载，避免重复解析。
          return loadSocialV2State();
        }
        // 兜底：没有分片也没有可迁移的旧文件，按原单文件逻辑读（首次运行路径）。
        fileStamp = (() => { try { const s = fs.statSync(socialFile); return `${s.size}:${s.mtimeMs}`; } catch { return null; } })();
        conversationsRaw = raw?.conversations || null;
        socialV2.paused = raw?.paused === true;
      }
      if (conversationsRaw && typeof conversationsRaw === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(conversationsRaw)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          // [OWNER-FLAG-FIX] 历史数据里她自己发的话曾被错标 isOwner=true；isOwner 只应表示主人。
          // 不迁移的话，任何"按 isOwner 认人"的渲染/判定都会把她说的话当成主人说的。
          try {
            for (const arr of [val.recentMessages, val.unread]) {
              if (!Array.isArray(arr)) continue;
              for (const m of arr) if (m && m.isSelf && m.isOwner) m.isOwner = false;
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-state.mjs:6729'); }
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // [STATE-WHITELIST-FIX] 未知字段直通：save 端已改为全量序列化，load 若仍按固定
          // 白名单重建，新字段会在读回时再次被丢掉（save/load 白名单必须同步漂移才出事的
          // 老坑）。定时器字段 load 端恒为 null（上方已显式给），磁盘里若有残留也不会复活。
          for (const [fk, fv] of Object.entries(val)) {
            if (typeof fv === 'undefined' || fk in st) continue;
            st[fk] = fv;
          }
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          lastSaved.set(key, JSON.stringify(serializeConversation(key, st)));
          lastSavedTask.set(key, JSON.stringify(serializeTaskState(key, st)));
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          // [BOOT-TDZ] loadSocialV2State() 在本文件里早于调度器依赖（let wakeSchedulerInst 等）初始化，
          // 启动阶段调用它会抛 "Cannot access 'wakeSchedulerInst' before initialization"，
          // 把整个状态加载一起打断 → 重启后状态只剩默认值（唤醒条件/未读/水位全丢）。
          // 这里只捕获启动阶段的这一次；正常的主动机会检查在 DSH 就绪后会重新武装。
          try { scheduleProactiveCheckV2(key); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-state.mjs:6816'); }
        }
        // 加载阶段统一落盘一次：分片模式幂等（per-key 写，互不覆盖）；
        // 旧单文件模式沿用 stale 检测，避免回写覆盖他进程更新。
        if (useShard) {
          saveSocialV2State();
        } else {
          const nowStamp = (() => {
            try { const s = fs.statSync(socialFile); return `${s.size}:${s.mtimeMs}`; } catch { return null; }
          })();
          if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
            log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
          } else {
            saveSocialV2State();
          }
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      fs.mkdirSync(SHARD_DIR, { recursive: true });
      // 全局元信息（暂停标志等）单独存 _meta.json，带锁，不与分片会话抢同一文件。
      withShardLock(META_FILE, () => atomicWriteJson(META_FILE, { paused: socialV2.paused === true, version: 1 }));
      for (const [key, st] of socialV2.conversations) {
        if (!/^(group|private):\d+$/.test(key)) continue;
        const relObj = serializeConversation(key, st);
        const relSer = JSON.stringify(relObj);
        const taskObj = serializeTaskState(key, st);
        const taskSer = JSON.stringify(taskObj);
        // [SHARD-AUDIT] 主分片（关系态）+ task 分片（任务态）各自独立文件、独立跨进程锁，
        // 只写有变化的分片：互不覆盖、互不阻塞，也更省 I/O。
        if (lastSaved.get(key) === relSer && lastSavedTask.get(key) === taskSer) continue;
        try {
          if (lastSaved.get(key) !== relSer) {
            withShardLock(shardFile(key), () => atomicWriteJson(shardFile(key), relObj));
            lastSaved.set(key, relSer);
          }
          if (lastSavedTask.get(key) !== taskSer) {
            withShardLock(taskFile(key), () => atomicWriteJson(taskFile(key), taskObj));
            lastSavedTask.set(key, taskSer);
          }
        } catch (error) {
          log(`保存社交分片失败 ${key}: ${error?.message ?? error}`);
        }
      }
    } catch (error) {
      log('保存 socialV2 分片失败:', error?.message ?? error);
    }
  }

  // [UNSENT] 排水（闭包版，可见 socialV2/saveSocialV2State）：把各会话里过期（>10min）的
  // noSendHint 沉底到顶层 unsent.json，再清内存。own-life/自唤醒组装前调一次，
  // 让「写了没发出去的话」沉到底部容器，而不是过期即遗忘。
  function drainUnsentHints() {
    try {
      const now = Date.now();
      let n = 0;
      // socialV2.conversations 是 Map（不是普通对象）：曾用 Object.entries 迭代，
      // 结果永远拿到空数组，过期挂心事从不沉底——一个不报错、只静默失效的坑。
      for (const [key, st] of socialV2.conversations) {
        const expired = takeExpiredHint(st?.noSendHint, now);
        if (expired) {
          sinkUnsentHint(expired.text, expired.at, key);
          st.noSendHint = null;
          n += 1;
        }
      }
      if (n) { saveSocialV2State(); log(`[unsent] ${n} 条过期挂心事沉底`); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-state.mjs:6885'); }
  }

  return { computeWakeSafetyV2, ensureWakeableV2, getSocialV2State, loadSocialV2State, saveSocialV2State, drainUnsentHints };
}
