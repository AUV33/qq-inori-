// own-life.js · 「她自己的生活」定时唤醒
//
// 干什么：隔一段时间给她一条**静默**提示（不会出现在聊天里），让她想起来
//         自己还有「说说 / 日记 / 画画 / 玩手机 / 什么都不干」这些事。
//
// 为什么需要它：桥接的自动唤醒只有三种 —— 有人说话、replyCheck、群聊 proactive。
//              私聊没有任何「你自己的时间到了」，所以角色卡里写了「你自己发说说」，
//              她也不会主动去做，只能等人手动叫。
//
// 用法（在 bridge.js 里）：
//
//   import { createOwnLife } from './own-life.js';
//
//   const ownLife = createOwnLife({
//     key: ownerKey,                                   // 'private:10001'
//     deliver: (text) => deliverPrompt(key, text, { silent: true, wakeReason: 'own-life' }),
//     statePath: path.join(STATE_DIR, 'own-life.json'),
//     log,
//   });
//   ownLife.start();
//
// 设计约束：
// - **静默**：提示只进 AI 的上下文，不往 QQ 发东西。
// - **不打扰**：凌晨 3–8 点不叫；一天最多 6 次。
// - **可关**：enabled=false 或 stop() 立刻停。
// - **断电续得上**：最后一次触发时间存在 statePath 里，重启不会一次补发一堆。

import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

// [PROMPTS] 独处提示词热加载：改 data/prompts/ownlife-day.md / ownlife-night.md 即生效，无需重启
import { loadText } from '../leaves/inori-prompts.js';

const HOUR = 3600 * 1000;

export const DEFAULT_TEXT_DAY = [
  '现在是你的时间，没人找你。',
  '先想清楚这段时间要做什么：接着没做完的事、发条说说、写日记、翻翻旧日记、看个视频、玩一会儿手机，或者就坐着什么都不干。',
  '想看视频就先想清楚想看什么，用 video_feed 给个关键词再挑；再 video_watch 一段段看；字幕和画面都看，不想看就关掉。',
  '要是最近挂心着什么（想多看一眼的、没弄明白的、想看后面会怎么样的），这会儿就是那个好时候——自己找来看，不用交代。',
  '玩手机也得有个具体的事：想玩哪个 App、进去干什么（看什么、玩哪一关、画哪张），想清楚了再 phone_open_app；',
  '想不清楚就先别开——为了"有个动作"去点手机，那不叫过日子。想看外面在说什么，可以 browse_posts 逛逛。',
  '看到值得记住的就 phone_info 记一条（朋友发的、游戏新版本、刷到的梗、你做到的事）——下次聊到能接上。',
  '看不清屏幕就 phone_look 看一眼（它会告诉你画面里是什么、有没有在动）。',
  '要是想到什么想明白的事——他说的话里有没有你没接住的、你自己哪里做得别扭——',
    '想的话可以翻翻旧日记（diary_recent / diary_days），看看以前的自己写了什么。',
  '就记一条经验（lesson_write），那是你自己攒下来的东西；刷到想多看一眼的、想知道后文的，挂上心（qq_curiosity record，来源写清）——不用现在就看，下回没人找你时你会想起它。',
  '想学一个新东西，就用 learning_item 记一条（写清为什么想学、什么叫比上次好）；想练就用 practice_start 练一次，不想练就放着。',
  '闲得彻底了可以去工坊给自己写点东西（qq_workshop：save 存个脚本、run 跑跑看）——给自己做的小工具、小游戏，放你的工坊里，下回还能接着改接着玩。',
  '不用回我，也不用汇报。',
].join('');

export const DEFAULT_TEXT_MIDNIGHT = [
  '半夜了，没人打扰。',
  '想干点什么吗——做点手上没做完的事、发说说、写日记，也可以就坐着什么都不干。',
  '或者翻翻自己攒下的经验（lesson_list），有新的想明白了就记一条。',
  '要是睡不着、脑子活，去工坊给自己写点东西（qq_workshop）也行——白天没空想的，夜里慢想。',
].join('');

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createOwnLife(opts) {
  const {
    key,
    deliver,
    statePath,
    intervalMs = 1 * HOUR,        // 每小时给一次"现在是你的时间"
    quiet = [3, 8],              // 3:00 ~ 8:00 不叫
    midnightAt = '23:30',
    maxPerDay = 6,
    // ★ 正在忙就往后推延：最多积压 maxDefer 次；再超就放弃这一次，并交给 onDrop 记进记忆。
    //   为什么不能无限推：推十次等于一次都没有，她永远等不到那个空档。
    maxDefer = 2,
    // [STARVE-FIX] 保底：一天里该给她的"自己的时间"若一次都没给到（firedToday < minPerDay），
    // 且已经饿过 3 个间隔，就跳过"正忙"这道门——否则群里一直热闹时她整天都没有自己的时间
    // （实测 10-25：dueAt 卡在 23:28、firedToday 0、放弃 4 次、推延 56 次）。0 = 不设保底。
    minPerDay = 2,
    dropBackoffMs = 10 * 60000,   // 放弃后多久重试（原来要等满一个间隔 40~80 分钟）
    deferLogEveryMs = 10 * 60000, // 推延日志限流（原来每 tick 一条）
    isBusy = () => false,
    onDrop = null,
    enabled = true,
    textDay = DEFAULT_TEXT_DAY,
    textMidnight = DEFAULT_TEXT_MIDNIGHT,
    // [IDLE-ASSOC] 可选：独处提示末尾附一句联想（字符串或 () => 字符串）；空串不附。
    extraLines = '',
    rhythmPath = null, // [RHYTHM-HERS] 她自调的节奏（state 文件，每 tick 热读）；null = 只有系统节奏
    log = (...a) => console.log('[own-life]', ...a),
  } = opts || {};

  if (!key) throw new Error('own-life: 缺 key');
  if (typeof deliver !== 'function') throw new Error('own-life: 缺 deliver');

  let state = { lastFiredAt: 0, lastDay: '', firedToday: 0, lastMidnightDay: '', deferred: 0, deferredAt: 0, dueAt: 0, droppedTotal: 0 };

  if (statePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object') state = { ...state, ...raw };
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'own-life.js:106'); }
  }

  function save() {
    if (!statePath) return;
    try {
      // 原子写（tmp+rename）：崩溃不留半截 JSON
      const r = writeJsonDocument(statePath, state, { source: 'bridge/own-life' });
      if (!r.ok) {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        atomicWriteJson(statePath, state, { pretty: true });
      }
    } catch (e) {
      log('状态写不进去（忽略）:', e?.message ?? e);
    }
  }

  function inQuiet(now, rh) {
    const h = new Date(now).getHours();
    const [from, to] = rh ? rh.quiet : quiet;
    return from <= to ? (h >= from && h < to) : (h >= from || h < to);
  }

  // [RHYTHM-HERS] 用户拍板（c）：她的自由时间节奏交给她自己调——
  // 桥接的 qq_set_own_life_rhythm 写 state 文件，这里每 tick 热读（1 分钟缓存，不用重启）。
  // 系统只管上下界（间隔 30min~12h、安静窗 0~24 点），节奏本身是她的。
  let rhythmCache = null;
  function currentRhythm(nowTs = Date.now()) {
    if (rhythmCache && nowTs - rhythmCache.ts < 60000) return rhythmCache;
    let iv = intervalMs;
    let q = quiet;
    if (rhythmPath) {
      try {
        const r = JSON.parse(fs.readFileSync(rhythmPath, 'utf8'));
        const a = Number(r.intervalMs);
        if (a > 0) iv = Math.min(Math.max(a, 30 * 60000), 12 * HOUR);
        if (Array.isArray(r.quiet) && r.quiet.length === 2 && Number.isFinite(Number(r.quiet[0])) && Number.isFinite(Number(r.quiet[1]))) {
          q = [Math.max(0, Math.min(24, Number(r.quiet[0]))), Math.max(0, Math.min(24, Number(r.quiet[1])))];
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'own-life.js:145'); }
    }
    rhythmCache = { ts: nowTs, intervalMs: iv, quiet: q };
    return rhythmCache;
  }

  function pastMidnightSlot(now) {
    const [mh, mm] = String(midnightAt).split(':').map(Number);
    const d = new Date(now);
    // [TIME-ZERO] `mh || 23` / `mm || 30` 会把合法的 0 点/0 分当成「没配」：
    // midnightAt="23:00" 实际被排到 23:30，23:10 的夜间槽位永远不触发。只对 NaN 回落。
    const hour = Number.isFinite(mh) ? Math.min(23, Math.max(0, mh)) : 23;
    const minute = Number.isFinite(mm) ? Math.min(59, Math.max(0, mm)) : 30;
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
    return now >= slot;
  }

  let timer = null;
  let busy = false;

  async function fire(kind, nowTs = Date.now()) {
    if (busy) return { ok: false, skipped: 'busy' };
    busy = true;
    const now = Number(nowTs) || Date.now();
    // 每次投递都读盘：改了 data/prompts/ownlife-*.md 立刻生效，不用重启
    const baseText = kind === 'midnight'
      ? loadText('ownlife-night', textMidnight)
      : loadText('ownlife-day', textDay);
    let extra = '';
    try { extra = String(typeof extraLines === 'function' ? extraLines({ kind, now }) : extraLines || '').trim(); } catch { extra = ''; }
    const text = extra ? `${baseText}\n\n${extra}` : baseText;
    try {
      await deliver(text);
      state.lastFiredAt = now;
      state.dueAt = 0; // [DUEAT-FIX] 投递成功后必须清"到点"标记：busy 推延时 state.dueAt 被持久化为旧时刻，
      // 不清的话每个 tick（60s）都判定"已到点"→ 一分钟连发一次直到 daily-cap（实测 12 次全在 10 分钟内打满）
      // 白天的投递才占每日额度；半夜反思槽位是保留的（[MIDNIGHT-CAP]，见 tick 里的说明）
      if (kind !== 'midnight') state.firedToday += 1;
      state.lastDay = dayKey(now);
      state.deferred = 0;
      state.deferredAt = 0;
      if (kind === 'midnight') state.lastMidnightDay = dayKey(now);
      save();
      log(`已投递（${kind}）${hhmm(now)} · 今天第 ${state.firedToday} 次`);
      return { ok: true, kind, at: now };
    } catch (e) {
      log('投递失败:', e?.message ?? e);
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      busy = false;
    }
  }

  async function tick(nowTs = Date.now()) {
    if (!enabled) return { ok: false, skipped: 'disabled' };
    const rh = currentRhythm(nowTs); // [RHYTHM-HERS] 每 tick 热读她自调的节奏（1 分钟缓存）
    if (inQuiet(nowTs, rh)) return { ok: false, skipped: 'quiet' };
    // [LIFE] 生活状态门（状态驱动的节奏，不再整点必发）：
    //   sleeping    → 她睡着：不发起，也不计积压（等她醒来，不补时）
    //   drowsy      → 犯困（困意过线）：困着的人不开新事，推延到她有精神
    //   in-progress → 正忙着一件活：不打断，推延
    const gate = typeof opts.getLifeGate === 'function' ? String(opts.getLifeGate(nowTs) ?? 'ok') : 'ok';
    if (gate === 'sleeping') return { ok: false, skipped: 'sleeping' };
    // 兼容旧版布尔门
    if (gate !== 'ok' && typeof opts.getShouldSkip === 'function' && opts.getShouldSkip(nowTs)) return { ok: false, skipped: 'sleeping' };

    // 跨天：计数归零
    const today = dayKey(nowTs);
    if (state.lastDay !== today) {
      state.lastDay = today;
      state.firedToday = 0;
    }
    // 半夜那次：一天一次，优先于普通间隔。★ 犯困时跳过——困着的人 23:30 不会冒"自己的时间"
    // [MIDNIGHT-CAP] 反思窗口不占白天频率上限：maxPerDay 限的是白天"自己的时间"次数，
    // 23:30 是唯一的夜间复盘槽位，白天地满时也不能被吞（之前 cap 检查在前 + midnight 计入 cap，
    // 有量的日子 23:30 永远轮不到——lastMidnightDay 实测卡了两天）
    if (pastMidnightSlot(nowTs) && state.lastMidnightDay !== today && gate !== 'drowsy') {
      return fire('midnight', nowTs);
    }
    // [OPEN-CAP] maxPerDay <= 0 = 不设每日上限：节奏仍由 interval 抖动 + 安静时段 + 生活门 + 忙推延兜着，
    // 不再另开一道额度闸（老板 10-25 定调：额度太少吃掉了她"自己玩"的时间，效果优先）
    if (Number(maxPerDay) > 0 && state.firedToday >= Number(maxPerDay)) return { ok: false, skipped: 'daily-cap' };

    // 该不该"现在"给机会：正常到点，或者先前已在推延（推延期间每个 tick 都重试）
    const lastAt = Number(state.lastFiredAt || 0);
    // ★ 到点时刻必须持久化：否则"从未触发过"时会每 tick 都重新算成"刚到点"，积压永远为 0。
    // [JITTER] 间隔不再整点：默认 1h 的 65%~135%（40~80 分钟）随机，节奏像人不像钟
    // [RHYTHM-HERS] 间隔取她自调值（有则用，无则系统默认），抖动逻辑不变
    const dueAt = Number(state.dueAt || 0) || (lastAt > 0 ? lastAt + Math.round(rh.intervalMs * (0.65 + Math.random() * 0.7)) : nowTs);
    if (nowTs < dueAt) return { ok: false, skipped: 'not-yet' };

    // 正在忙：往后推延。★ 计数按"错过了几个整轮"算，不是按 tick 次数——
    // 否则她忙三分钟（3 次 tick）就会把这一小时的机会丢掉，那太苛刻了。
    let busyNow = false;
    try { busyNow = isBusy() === true; } catch { busyNow = false; }
    if (gate === 'drowsy') busyNow = true; // [LIFE] 犯困就不开新事
    // [STARVE-FIX] "正忙"不再是死门：饿够久（连着 3 个间隔没给到）且今天还没给够 minPerDay 次时让路。
    // 仍尊重睡着/犯困——那两条是她真的需要休息，不是被群聊占着。
    // 判据：今天还没给够 minPerDay 次，且这次该给的时间已经被拖了 30 分钟以上。
    const starved = Number(minPerDay) > 0
      && Number(state.firedToday || 0) < Number(minPerDay)
      && nowTs - dueAt > 30 * 60000;
    if (gate === 'in-progress' && !starved) busyNow = true;
    if (gate === 'in-progress' && starved && nowTs - Number(state.lastStarveLogAt || 0) > 30 * 60000) {
      state.lastStarveLogAt = nowTs;
      log(`今天还没给到自己的时间（已 ${state.firedToday || 0}/${minPerDay} 次），这次跳过「正忙」让路`);
      save();
    }
    if (busyNow) {
      const pending = Math.max(0, Math.floor((nowTs - dueAt) / rh.intervalMs)); // 已积压几轮
      state.dueAt = dueAt;
      state.deferred = pending;
      state.deferredAt = nowTs;
      if (pending > maxDefer) {
        state.dueAt = 0;
        state.deferred = 0;
        state.deferredAt = 0;
        state.droppedTotal = Number(state.droppedTotal || 0) + 1;
        // 放弃这一次；但不让一次 drop 吃掉整个间隔——10 分钟后再试，等一个空档补上。
        state.lastFiredAt = nowTs;
        state.dueAt = nowTs + Math.max(60000, Number(dropBackoffMs) || 10 * 60000);
        save();
        log(`已经积压 ${pending} 轮都在忙，这次独处机会放弃（累计放弃 ${state.droppedTotal} 次）`);
        try { if (typeof onDrop === 'function') await onDrop({ at: nowTs, count: pending, total: state.droppedTotal }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'own-life.js:261'); }
        return { ok: false, skipped: 'dropped', pending };
      }
      save();
      if (nowTs - Number(state.lastDeferLogAt || 0) > Number(deferLogEveryMs || 0)) {
        state.lastDeferLogAt = nowTs;
        // 说清楚被什么挡住：drowsy=犯困 / in-progress=她正在动手 / 其余=会话忙
        const why = gate === 'drowsy' ? '犯困' : (gate === 'in-progress' ? '她正在动手' : '会话忙');
        log(`往后推延（${why}，已积压 ${pending}/${maxDefer} 轮）`);
      }
      return { ok: false, skipped: 'deferred', deferred: pending };
    }

    return fire('day', nowTs);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/own-life.js:290')); }, 60 * 1000).unref?.() ?? setInterval(() => { tick().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/own-life.js:290')); }, 60 * 1000);
    log(`已武装 · 每 ${(intervalMs / HOUR).toFixed(1)}h 一次 · 忙则推延（最多积压 ${maxDefer} 次）· 安静时段 ${quiet[0]}:00–${quiet[1]}:00 · 半夜 ${midnightAt} · ${Number(maxPerDay) > 0 ? `每天最多 ${maxPerDay} 次` : '不设每日额度'}`);
    // 启动后 90 秒先看一眼（别和开机时的会话创建抢）
    setTimeout(() => { tick().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/own-life.js:293')); }, 90 * 1000).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    log('已停止');
  }

  return {
    start, stop, tick,
    fireNow: () => fire('day'),
    fireMidnightNow: () => fire('midnight'),
    snapshot: () => ({ ...state, enabled, intervalMs, quiet, midnightAt, rhythm: currentRhythm() }),
  };
}

export default createOwnLife;
