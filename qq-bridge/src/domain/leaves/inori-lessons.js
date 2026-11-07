// inori-lessons.js · 她的"经验"（自我认知，不是事实记忆）
//
// 与 memory 的分工（重要，别混）：
//   memory  = 关于世界/他的事实（"他下周生日"）→ 需要检索，因为量大且只偶尔相关
//   lessons = 关于她自己的经验（"他一说累我就急着给建议，他不爱听"）→ 数量少、长期有效，所以**常驻注入**
//
// 为什么单独存：事实会过期、经验会累积。混在一起的结果是经验被事实海淹没。
//
// 纪律：
//   1) 纯函数 + JSONL 追加，零依赖
//   2) 有界：单条 ≤120 字；活跃经验 ≤30 条（满了就淘汰最久没被"用到"的）
//   3) 可机械断言：写入/去重/淘汰/渲染都能验
//   4) 内容由她自己写，框架不生成
//
// 落盘：data/state/lessons.jsonl（一行一条）

import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendJsonl, rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('lessons.jsonl'),
  maxChars: 120,
  maxActive: 30,
  injectRecent: 5,
  expireDays: 60,
  // [EXPE] 借鉴 ExpeL：洞见要能投票淘汰；借鉴 LangMem：带 trigger/confidence
  defaultConfidence: 0.7,
  upStep: 0.15,
  downStep: 0.25,
  dropBelow: 0.2,
  triggerMax: 40,
  // [VOYAGER] 「这条经验怎么验」：学到一个东西时顺手写下判据（做一次看结果对不对）。
  // 只存不强制；有判据的经验在渲染时会被标出来，方便她回头验。
  verifyMax: 80,
};

const nowIso = () => new Date().toISOString();
const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

// [TRACK-SPLIT] 两条学习轨：doing = 能截图/命令验证的操作程序；reading = 读人/关系/审美这类没有机器判据的判断。
// 混在一个池子里时，操作笔记会按"相关度"挤掉读人的经验——这是 2026-10-31 复盘的核心问题。
export const TRACKS = ['doing', 'reading'];
const TRACK_LABEL = { doing: '做法', reading: '判断' };
const DOING_RE = /手机|adb|截图|点击|坐标|按钮|界面|app|App|画世界|笔刷|部署|方舟|游戏|安装|下载|搜索|工具|命令|接口|文件|路径|进程|重启|qq_|phone_|skill|登录|账号|锁屏|锁|wait|recovery|SnowLuma|网关|send_|result=|风控|judge-|textAny|video_|feed|OCR|dump|模板|预览|像素|队列|重试|报错|HTTP|制造站|贸易站|干员|基建|剿灭|关卡|费用|技能/i;

/** 老数据没有 track：按文本先判是否操作/工具/游戏，再按 kind 判读人；判不准归 reading（宁可少注入操作）。 */
export function inferTrack(x = {}) {
  const t = String(x.track ?? '').trim();
  if (TRACKS.includes(t)) return t;
  if (DOING_RE.test(String(x.text ?? ''))) return 'doing';
  if (x.kind === 'about-him' || x.kind === 'about-us' || x.kind === 'about-people') return 'reading';
  return 'reading';
}

export function load(file = DEFAULTS.file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && typeof x.text === 'string')
      .map((x) => ({
        id: String(x.id ?? ''),
        text: String(x.text),
        kind: ['about-him', 'about-me', 'about-us', 'about-people'].includes(x.kind) ? x.kind : 'about-me',
        track: inferTrack(x),
        at: x.at ?? nowIso(),
        usedAt: x.usedAt ?? x.at ?? nowIso(),
        hits: Number(x.hits ?? 0),
        // [EXPE] 什么时候适用（LangMem 的 trigger）+ 置信度（ExpeL 的 importance）
        trigger: String(x.trigger ?? '').slice(0, DEFAULTS.triggerMax),
        verify: String(x.verify ?? '').slice(0, DEFAULTS.verifyMax),
        // [TRACK-SPLIT] 判断轨的反例：没有反例的判断最容易用错地方。
        counterexample: String(x.counterexample ?? '').slice(0, 100),
        confidence: Number.isFinite(Number(x.confidence)) ? Math.min(1, Math.max(0, Number(x.confidence))) : DEFAULTS.defaultConfidence,
        up: Number(x.up ?? 0),
        down: Number(x.down ?? 0),
        // [L2] 每日 up 上限的日期标记：必须在白名单里，否则 rewrite 后又被丢掉
        lastUpDay: String(x.lastUpDay ?? ''),
      }));
  } catch { return []; }
}

export function append(entry, file = DEFAULTS.file) {
  const result = appendJsonl(file, entry, { source: 'lessons' });
  if (!result.ok) throw new Error(result.error || '经验写入失败');
  return entry;
}

/** 字符二元组重叠（无分词器，与 memory 一致的做法） */
function bigrams(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * 新增一条经验。返回 {ok, reason?, entry?, dropped?}
 * dropped = 因为超过 maxActive 被淘汰的那一条
 */
export function add(list, text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const body = clip(text, o.maxChars);
  if (!body) return { ok: false, reason: 'empty' };
  const track = inferTrack({ track: opts.track, kind: opts.kind, text: body });
  const counterexample = clip(opts.counterexample ?? '', 100);
  // [TRACK-SPLIT] 判断轨只收「判断 + 反例」：没有反例的判断下次最容易用错地方。
  if (track === 'reading' && o.requireCounterexample && !counterexample) {
    return { ok: false, reason: 'counterexample-required', track };
  }
  // [DEDUPE-MIN] overlap 按 min 归一：一条短经验（"别催"只有 1-2 个 bigram）会被任何
  // 包含它的长经验算成 1.0，于是后面的经验全被静默判重。和 mergeNear 一样加"足够长"守卫：
  // 短文本本来就没有可靠的重复判据，宁可多存一条，也不能吞掉新经验。
  if ([...body].length >= 8 && list.some((x) => [...String(x?.text ?? '')].length >= 8 && overlap(x.text, body) >= 0.85)) {
    return { ok: false, reason: 'duplicate' };
  }
  // [LESSON-MERGE] 近重复合并是显式策略（mergeNear=true 才生效），默认 add() 语义保持不变
  if (o.mergeNear) {
  // [LESSON-MERGE] 同 kind/同轨的近重复（0.6–0.85）不新增，合并进已有那条：更长正文、较高置信度、补 trigger
    // 守卫：只有足够长（≥8 字）且长度相近（差 ≤8）的两条才做「近重复合并」，
    // 否则短文本（「经验0」「经验1」）会因二元组重叠被误合并成一条。
    const near = [...body].length >= 8
      ? list.find((x) => inferTrack(x) === track
          && String(x.kind ?? 'about-me') === String(opts.kind ?? 'about-me')
          && [...String(x.text ?? '')].length >= 8
          && Math.abs([...String(x.text ?? '')].length - [...body].length) <= 8
          && overlap(x.text, body) >= 0.6 && overlap(x.text, body) < 0.85)
      : undefined;
    if (near) {
      if ([...body].length > [...String(near.text ?? '')].length) near.text = body;
      near.confidence = Math.max(Number(near.confidence ?? o.defaultConfidence), Number(opts.confidence ?? o.defaultConfidence));
      near.usedAt = nowIso();
      near.mergedFrom = Number(near.mergedFrom || 1) + 1;
      if (!near.trigger && opts.trigger) near.trigger = clip(opts.trigger, o.triggerMax);
      if (!near.verify && opts.verify) near.verify = clip(opts.verify, o.verifyMax);
      if (!near.counterexample && counterexample) near.counterexample = counterexample;
      return { ok: true, merged: true, entry: near };
    }
  }

  const entry = {
    id: 'l' + crypto.randomBytes(4).toString('hex'),
    text: body,
    kind: opts.kind ?? 'about-me',
    track,
    at: nowIso(),
    usedAt: nowIso(),
    hits: 0,
    trigger: clip(opts.trigger ?? '', o.triggerMax),
    verify: clip(opts.verify ?? '', o.verifyMax),
    counterexample,
    confidence: Number.isFinite(Number(opts.confidence)) ? Math.min(1, Math.max(0, Number(opts.confidence))) : o.defaultConfidence,
    up: 0,
    down: 0,
  };
  // 有界：按「最久没被用到」淘汰，而不是最早写入（常用经验应留更久）
  let dropped = null;
  if (list.length >= o.maxActive) {
    const oldest = list.slice().sort((a, b) => String(a.usedAt).localeCompare(String(b.usedAt)))[0];
    dropped = oldest;
    const i = list.indexOf(oldest);
    if (i >= 0) list.splice(i, 1);
  }
  list.push(entry);
  return { ok: true, entry, dropped };
}

/** 标记"这条经验被用到了"（影响淘汰顺序） */
export function touch(list, id) {
  const x = list.find((e) => e.id === id);
  if (!x) return false;
  x.usedAt = nowIso();
  x.hits += 1;
  return true;
}

/**
 * [EXPE] 给一条经验投票。借鉴 ExpeL 的 UPVOTE/DOWNVOTE + 票数归零删除。
 *   up   → 置信度 +0.15：这条我验证过确实对
 *   down → 置信度 -0.25：这条其实不对（错误比正确更该被记，所以降得更狠）
 * @returns {{ok:boolean, removed?:boolean, entry?:object, reason?:string}}
 */
export function vote(list, id, dir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return { ok: false, reason: 'not-found' };
  const e = list[i];
  if (dir === 'up') {
    e.up = Number(e.up ?? 0) + 1;
    e.confidence = Math.min(1, +(Number(e.confidence ?? o.defaultConfidence) + o.upStep).toFixed(3));
  } else if (dir === 'down') {
    e.down = Number(e.down ?? 0) + 1;
    e.confidence = Math.max(0, +(Number(e.confidence ?? o.defaultConfidence) - o.downStep).toFixed(3));
  } else {
    return { ok: false, reason: 'bad-dir' };
  }
  e.usedAt = nowIso();
  if (e.confidence <= o.dropBelow) {
    list.splice(i, 1);
    return { ok: true, removed: true, entry: e };
  }
  return { ok: true, entry: e };
}

/** 太老的放下（默认 60 天没被用到） */
export function expire(list, days = DEFAULTS.expireDays) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const fresh = list.filter((x) => Date.parse(x.usedAt) >= cutoff);
  return { kept: fresh, dropped: list.length - fresh.length };
}

/** 给模型看：最近的经验（常驻注入，因为数量少且长期有效） */

/**
 * [EXPE] 按上下文挑经验：相关度（与正文/trigger 的二元组重叠）为主，置信度/hits 为辅；
 * 没有相关命中时回退到 select() 的置信度前 N（保持原行为）。
 */

/**
 * [TRIGGER] 从上下文推断一条"什么时候适用"的触发词（确定性，不做语义）：
 * 取出现 ≥2 次的二字词（去停用词），最多两个词拼成 trigger；没有稳定词就返回空。
 */
export function inferTrigger(contextText, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ctx = String(contextText ?? '');
  if (!ctx.trim()) return '';
  const stop = new Set('的了是在有和就不都一个我你他她它们这那什么怎么然后还是因为所以但是而且可以没有我们你们他们现在今天明天昨天说道说着时候一下一会这样那样自己知道觉得如果想会要能吧呢啊吗哦嗯'.split(''));
  const freq = new Map();
  for (const seg of ctx.split(/[\s，。！？、；：""''（）()\[\]【】…~—\-]+/)) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= seg.length; i += 1) {
        const w = seg.slice(i, i + n);
        if ([...w].some((ch) => stop.has(ch))) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  // 优先高频、同频取长词；与已选词互相包含的碎片跳过（避免「三角/角洲」这种重叠碎片）
  const candidates = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length));
  const picked = [];
  for (const [w] of candidates) {
    if (picked.length >= 2) break;
    if (picked.some((p) => p.includes(w) || w.includes(p))) continue;
    picked.push(w);
  }
  return picked.join('/').slice(0, o.triggerMax);
}function onlyTracks(list, tracks) {
  const wanted = Array.isArray(tracks) ? tracks.filter((t) => TRACKS.includes(t)) : [];
  if (!wanted.length) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter((x) => wanted.includes(inferTrack(x)));
}

export function selectForContext(list, contextText, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ctx = String(contextText ?? '');
  const all = onlyTracks(list, o.tracks);
  if (!ctx.trim()) return { ...select(all, o), matched: false };
  const scored = all.map((x) => {
    const rel = overlap(ctx, `${x.text ?? ''} ${x.trigger ?? ''}`.trim());
    const conf = Number(x.confidence ?? o.defaultConfidence);
    return { x, rel, score: rel * 0.8 + conf * 0.2 };
  });
  // [LESSON-ROTATE] 阈值提高：0.06 几乎每条都命中，等于没有“相关”。
  // wake 路径传 rotate:true 时，没有相关命中就按“最久没被注入”轮换，避免同一批高置信经验常驻。
  const minRel = Number.isFinite(Number(o.minRel)) ? Number(o.minRel) : 0.15;
  const hit = scored.filter((s) => s.rel >= minRel).sort((a, b) => b.score - a.score);
  if (!hit.length) return { ...select(all, { ...o, rotate: o.rotate === true }), matched: false };
  const picked = hit.slice(0, o.injectRecent).map((s) => s.x);
  return { selected: picked, text: render(picked, o), matched: true };
}

export function select(list, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const selected = onlyTracks(list, o.tracks).slice().sort((a, b) => {
    if (o.rotate) {
      // 轮换：最久没被“用到”（注入）的先来；同时间按置信度。
      const ua = Date.parse(String(a.usedAt ?? a.at ?? '')) || 0;
      const ub = Date.parse(String(b.usedAt ?? b.at ?? '')) || 0;
      if (ua !== ub) return ua - ub;
    }
    const scoreA = Number(a.confidence ?? o.defaultConfidence);
    const scoreB = Number(b.confidence ?? o.defaultConfidence);
    return scoreB - scoreA || String(b.usedAt ?? b.at).localeCompare(String(a.usedAt ?? a.at));
  }).slice(0, o.injectRecent);
  return { selected, text: render(selected, o) };
}

export function render(list, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!list.length) return '';
  const recent = list.slice(0, o.injectRecent);
  const label = { 'about-him': '关于他', 'about-me': '关于你自己', 'about-us': '关于你们', 'about-people': '关于别人怎么说话' };
  const lines = recent.map((x) => {
    const rawTrig = String(x.trigger ?? '').trim();
    const trig = rawTrig ? `（${/(时|的时候)$/.test(rawTrig) ? rawTrig : `当${rawTrig}时`}）` : '';
    const track = TRACK_LABEL[inferTrack(x)] || '判断';
    const counter = x.counterexample ? `｜反例：${x.counterexample}` : '';
    return `- [${track}·${label[x.kind] ?? '关于你自己'}] ${x.text}${trig}${counter}`;
  });
  return `你以前想明白过的事（别当规矩背，是你自己的经验）：\n${lines.join('\n')}`;
}

/** 覆盖写回（淘汰/过期后需要落盘；JSONL 改为整写，保持文件干净） */
export function rewrite(list, file = DEFAULTS.file) {
  const result = rewriteJsonl(file, list, { source: 'lessons' });
  if (!result.ok) throw new Error(result.error || '经验整理失败');
  return list;
}
