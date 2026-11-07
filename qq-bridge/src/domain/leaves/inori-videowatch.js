// inori-videowatch.js · 像人一样接收视频：方向盘，不是油门。
//
// 三块（对应派 3 的三条腿）：
//  ① 候选池：只按她给的关键词搜 B站，不摆热榜、不按弹幕密度替她挑
//  ② 感知循环 step：open → look(30s 窗口) → skip / rewatch / exit(take)，耐心 = 窗口数（来自她的无聊度）
//  ③ 留存 encodeMemory：记的是"她的读法 + 她当时的状态"，不是转写稿
//
// 纯函数（无 fs/网络）：数据来自 watch-video.js 的网络层，状态由调用方持有。

import { boredomOf } from './inori-lifestate.js';

const WINDOW_SEC = 30;

/** 候选池给她看的样子（编号=她之后 open 用的 index） */
export function renderFeed({ list, note }) {
  if (!list.length) return note || '（空）';
  const lines = list.map((v, i) => {
    const mm = Math.floor((Number(v.duration) || 0) / 60);
    const ss = String((Number(v.duration) || 0) % 60).padStart(2, '0');
    const viewTxt = Number(v.view) >= 10000 ? `${(Number(v.view) / 10000).toFixed(1)}万` : String(v.view ?? 0);
    return `${i + 1}. ${v.title}\n   UP：${v.owner}　${mm}:${ss}　播放${viewTxt}\n   [${v.bvid}]`;
  });
  return [note ? `（${note}）` : '', ...lines].filter(Boolean).join('\n');
}

/**
 * [VIDEO-STREAM] 从候选队列取下一條；不自动播，只把“下一条”递给她。
 * seen 用于避开她最近看过的；队列走完返回 exhausted=true，由调用方决定是否刷新热榜。
 * 纯函数，方便测试。
 */
export function pickNextCandidate(feed, { seen = [] } = {}) {
  const list = Array.isArray(feed?.list) ? feed.list : [];
  const seenSet = new Set((Array.isArray(seen) ? seen : []).map(String));
  let index = Math.max(0, Number(feed?.nextIndex) || 0);
  while (index < list.length) {
    const entry = list[index];
    const bvid = String(entry?.bvid ?? '');
    index += 1;
    if (!bvid || seenSet.has(bvid)) continue;
    return { entry, nextIndex: index, exhausted: false };
  }
  return { entry: null, nextIndex: index, exhausted: true };
}

/** ② 耐心 = 她可以连续 look 几个窗口。无聊度越高越能看下去；刚聊完就两三眼。 */
export function patienceWindows(lifeState, now = Date.now()) {
  const bo = Math.round(boredomOf(lifeState, now) * 100);
  const windows = Math.max(3, Math.min(12, 3 + Math.round((bo / 100) * 9)));
  return { windows, boredomPct: bo };
}

/** 新会话：一条视频 + 耐心预算。人一次只看一条。 */
export function openSession(entry, patience) {
  const windows = Number(patience?.windows) || 6;
  return {
    bvid: entry.bvid, title: entry.title, owner: entry.owner,
    duration: Number(entry.duration) || 0,
    pos: 0, windowsLeft: windows, windowsTotal: windows,
    ended: null, take: null, openedAt: Date.now(),
  };
}

/** ② 一步感知。action =
 *   {op:'look'}          看当前 30s 窗口（pos → +30，耗 1 耐心）
 *   {op:'skip', to}      跳到 to 秒（也耗 1 耐心——快进也是看）
 *   {op:'rewatch'}       回看刚才 30s（免费——人随时倒带）
 *   {op:'exit', take}    合上，写一句她当时的想法（可空：空 = "没看完，走神了"本身也是读法）
 * 返回 { session, note, viewWindow } —— viewWindow 交给 windowView() 切内容。 */
export function stepSession(sess, action) {
  const s = { ...sess };
  const op = String(action?.op ?? '').trim().toLowerCase();
  const windowOf = (from) => ({ from, to: Math.min(s.duration, from + WINDOW_SEC) });
  switch (op) {
    case 'look': {
      if (s.ended) return { session: s, note: '这条已经看完了（或你刚合上）。想重看就再 open。' };
      if (s.pos >= s.duration) {
        s.ended = 'ended';
        return { session: s, note: '已经到片尾了。exit 合上，把想法留一句。' };
      }
      const w = windowOf(s.pos);
      s.pos = w.to;
      s.windowsLeft = Math.max(0, s.windowsLeft - 1);
      if (s.windowsLeft === 0) {
        s.ended = 'tired';
        return { session: s, note: `看完了 0:${w.from}s→${w.to}s。耐心（${s.windowsTotal} 个窗口）用完了——人也有看不下去的时候，exit 合上就好。`, viewWindow: w };
      }
      return { session: s, note: `看了 ${fmt(w.from)}→${fmt(w.to)}（耐心还剩 ${s.windowsLeft}/${s.windowsTotal}，随时可以 skip / rewatch / exit）。`, viewWindow: w };
    }
    case 'skip': {
      if (s.ended) return { session: s, note: '这条已经合上了。' };
      const to = Math.max(0, Math.min(s.duration, Number(action.to) || 0));
      const w = windowOf(to);
      s.pos = w.to;
      s.windowsLeft = Math.max(0, s.windowsLeft - 1);
      if (s.windowsLeft === 0) s.ended = 'tired';
      return { session: s, note: `跳到 ${fmt(to)} 接着看（耐心 ${s.windowsLeft}/${s.windowsTotal}${s.ended ? '，用完' : ''}）。`, viewWindow: w };
    }
    case 'rewatch': {
      if (s.ended) return { session: s, note: '这条已经合上了。' };
      const back = Math.max(0, s.pos - WINDOW_SEC);
      const w = windowOf(back);
      // 回看的是刚看过的那 30s：看完停回原处（位置不变，不耗耐心）
      return { session: s, note: `倒带回 ${fmt(back)}→${fmt(back + WINDOW_SEC)} 又看了一遍（倒带不耗耐心）。`, viewWindow: w };
    }
    case 'exit': {
      s.ended = s.ended ?? 'chose';
      s.take = String(action.take ?? '').trim() || null;
      return { session: s, note: s.take ? `合上了，想法记下了。` : '合上了。（没留想法——"没看完"也是看的一部分。）' };
    }
    default:
      return { session: s, note: `不认识的 op（${op}）。可用：look / skip / rewatch / exit。` };
  }
}

/** ③ 留存：一条 memory.jsonl 的 event。她当时的读法 + 状态，不是转写稿。 */
export function encodeMemory(sess, ctx) {
  const watched = Math.min(Number(sess.pos) || 0, Number(sess.duration) || 0);
  const why = sess.ended === 'tired' ? '耐心用完了，看不下去了' : sess.ended === 'ended' ? '看到片尾了' : '她自己合上的';
  const hot = (ctx?.topPhrases ?? []).slice(0, 2)
    .map((p) => `${p.phrase}×${p.n}`)
    .filter(Boolean).join('、');
  const parts = [
    `看了「${sess.title}」（UP:${sess.owner ?? '?'}）到 ${fmt(watched)}（全片 ${fmt(sess.duration)}），${why}。`,
  ];
  if (hot) parts.push(`弹幕里出现最多的反应：${hot}。`);
  parts.push(sess.take ? `我当时的想法：${sess.take}` : '没留下什么想法——那段看进去了没看进去，看的时候自己没留意。');
  // [THOUGHT] 记的是「我由此想到了什么」，不是视频的转写稿；感触、联想、知识、反问都算。
  parts.push('（这条只记她自己的读法，不复述内容。）');
  return {
    kind: 'event',
    prov: 'video-watch',
    bvid: sess.bvid,
    watchedSec: watched,
    text: parts.join(''),
  };
}

function fmt(sec) {
  const mm = Math.floor((Number(sec) || 0) / 60);
  const ss = String(((Number(sec) || 0) % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}
