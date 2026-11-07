// wake-trigger.mjs · 「这条消息该不该叫醒她」的纯判定（从 bridge.js 的 main() 抽出，S2-2）
//
// 为什么单独成模块：
//   这是整个桥接里最常跑的一段判定——**每条群消息都要过一遍**，而且它决定的是
//   "她会不会突然开口"这种可感知的行为。以前它埋在 main() 的 16k 行闭包里，
//   只能靠线上日志看"为什么又叫了/为什么没叫"，改一个关键词的边界没人能证明没回归。
//   抽出来后：输入是什么、命中哪条规则、概率怎么判，都可以离线锁死。
//
// 纪律：
//   · 纯判定，零 IO、零定时器；概率用注入的 random（默认 Math.random），测试可控。
//   · 返回命中的**原因字符串**（`private` / `atMention` / `keyword:DS` …），
//     调用方用它做日志与调度；返回 null = 不唤醒。
//   · 规则顺序就是优先级：anyMessage > atMention > nameMention > aboutSelf > keywords
//     > question > speaker > probability。改顺序等于改行为，别顺手调。
//   · [ADDRESS-FIRST] 直接叫她（@/引用/名字）排在「议论她」前面：以前 aboutSelf 在前，
//     每条 @ 都被判成 aboutSelf:alias，提示词挂的是「他们在说你」而不是「有人@你」——
//     实测 3 小时 alias 39 次、@ 只有 9 次，是接话错位的一大来源。

import { detectAboutSelf, DEFAULTS as ABOUTSELF_DEFAULTS } from '../leaves/inori-aboutself.js';
import { isDirectedAtAi } from '../leaves/inori-directed.js';

/** 这条消息是否 @ 了她（事件级判定；休眠门与唤醒触发共用）。 */
export function messageAtsSelf(event) {
  return Array.isArray(event?.message)
    && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
}

// 单字名叫她时，先排掉这些常见词（昵称末字恰好是常用词的一部分时，那句不是在叫她）。
// 默认针对中文里最常见的「祈」；换角色可用 config.socialV2.aboutSelf.singleCharBlock 覆盖
// （字符串数组或正则源码字符串）。
const DEFAULT_SINGLE_CHAR_BLOCK = /祈祷|祈求|祈愿|祈使|祈盼|祈禱/;
// 单字名只在短消息里算「喊名字」（长句里出现一个单字多半是行文，不是叫她）。
const SINGLE_CHAR_MAX_LEN = 10;

function blockMatcher(extra) {
  if (extra instanceof RegExp) return extra;
  if (Array.isArray(extra) && extra.length) {
    const words = extra.map((w) => String(w ?? '')).filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (words.length) return new RegExp(words.join('|'));
  }
  if (typeof extra === 'string' && extra.trim()) return new RegExp(extra);
  return DEFAULT_SINGLE_CHAR_BLOCK;
}

/**
 * 她有没有被"叫名字"：全名 / 别名 / 单字名（带防护）。
 *
 * 为什么需要它：以前 nameMention 只做 `text.includes(selfNickname)`，全名才命中；
 * 别名只在 aboutSelf 里匹配，而 aboutSelf 有「同一个人 10 分钟只叫醒一次」的冷却——
 * 于是反复叫昵称反而一条都叫不醒（2026-10-29 实测：全名之外全不唤醒）。
 *
 * @param {string} text
 * @param {{nickname?:string, aliases?:string[], singleCharBlock?:RegExp|string[]|string}} opts
 * @returns {string} 命中的名字；空串 = 没叫
 */
export function matchNameCall(text, { nickname = '', aliases = [], singleCharBlock } = {}) {
  const flat = String(text ?? '').toLowerCase();
  if (!flat.trim()) return '';
  const block = blockMatcher(singleCharBlock);
  const names = [nickname, ...(Array.isArray(aliases) ? aliases : [])]
    .map((x) => String(x ?? '').toLowerCase().trim())
    .filter(Boolean);
  // ① 全名/多字别名：直接子串命中
  for (const n of names) {
    if (n.length >= 2 && flat.includes(n)) return n;
  }
  // ② 单字名（取昵称末字，如「小满」→「满」）：只在短消息、且不是常见词时算
  const nick = String(nickname || '').toLowerCase().trim();
  const shortNames = new Set();
  if (nick.length >= 2) shortNames.add(nick.slice(-1));
  for (const n of names) if (n.length === 1) shortNames.add(n);
  for (const s of shortNames) {
    if (!s || !flat.includes(s)) continue;
    if (block.test(flat)) continue;
    if (flat.replace(/\s+/g, '').length > SINGLE_CHAR_MAX_LEN) continue;
    return s;
  }
  return '';
}

/**
 * 判定一次唤醒触发。
 *
 * @param {string} key            会话 key（`group:123` / `private:456`）
 * @param {object} st             socialV2 会话状态（读 `st.wakeConfig.triggers`）
 * @param {object} event          OneBot 事件（读 sender / user_id / message）
 * @param {'group'|'private'} kind
 * @param {string} textContent    本条文本（含 @ 等标记）
 * @param {string} plainContent   纯文本（剥掉 CQ 码后）
 * @param {boolean} quoteTargetIsSelf 引用的消息是否她本人
 * @param {{cfg?:object, selfNickname?:string, random?:() => number}} [deps]
 * @returns {string|null} 命中原因；null = 不唤醒
 */
export function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf, deps = {}) {
  const { cfg = null, selfNickname = '', random = Math.random } = deps;

  if (kind === 'private') return 'private';
  const tr = st?.wakeConfig?.triggers ?? {};
  if (tr.anyMessage) return 'anyMessage';

  // 直接叫她：@ 段 / 引用她 / 昵称出现在文本里 —— 这三类先判，别让「议论她」抢走。
  if (tr.atMention && (messageAtsSelf(event) || quoteTargetIsSelf)) return 'atMention';

  if (tr.nameMention) {
    // [NAME-CALL] 全名 / 别名 / 单字名都算叫她；别名走这里就不再被 aboutSelf 的 10 分钟冷却吃掉。
    const hit = matchNameCall(plainContent ?? textContent ?? '', {
      nickname: selfNickname,
      aliases: cfg?.socialV2?.aboutSelf?.aliases ?? ABOUTSELF_DEFAULTS.aliases,
      singleCharBlock: cfg?.socialV2?.aboutSelf?.singleCharBlock,
    });
    if (hit) return 'nameMention';
  }

  // [ABOUT-SELF] 提到她/议论她 → 主动开口（不依赖关键词表，纯本地字符串规则）。
  // [ALIAS-COOLDOWN] 调用方可以传 aboutSelfAllowed(senderId) 做同一个人短时间冷却，
  // 避免一个爱提她名字的人把整场对话都变成「他们在说你」。
  if (cfg?.socialV2?.aboutSelf?.enabled !== false) {
    const senderId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    const allowed = typeof deps.aboutSelfAllowed === 'function' ? deps.aboutSelfAllowed(senderId) : true;
    if (allowed) {
      const hit = detectAboutSelf(plainContent ?? textContent ?? '', cfg?.socialV2?.aboutSelf ?? {});
      if (hit.hit) return `aboutSelf:${hit.kind}`;
    }
  }

  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }

  if (tr.question && isDirectedAtAi(plainContent)) return 'question';

  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return `speaker:${senderLabel}`;
    }
  }

  if (Number(tr.probability) > 0 && random() < Number(tr.probability)) return 'probability';
  return null;
}
