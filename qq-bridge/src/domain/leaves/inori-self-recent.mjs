// inori-self-recent.mjs · 「你最近说过/做过什么」——跨会话的自我连续性
//
// 2026-10-30 现场：20:46 她在私聊说「电脑上起一张白图，四条曲线围出翅膀…」，
// 20:48 在群里却答「群里别人发的，我顺手存下来的」；21:00 又说「蝴蝶我没画过」。
// 同一模型、两个会话：群会话的上下文里没有私聊会话做过的事，于是各说各的（左右脑互博）。
//
// 这里只做一件事：把她在「其它会话」里最近说过/做过的事，压成 2–3 行递进当前会话。
// 纪律：
//   · 只收她自己的话（isSelf / kind=utterance），不收对方在私聊说了什么；
//   · 私聊→群默认关闭，必须由 sharePrivate=true 显式打开（群→私聊默认允许，可用 shareGroup=false 关）；
//     这条和记忆召回共用同一个开关，避免「记忆关了、自述还在漏」；
//   · 只收最近 maxAgeMs（默认 3 小时），过期的不算「最近做过的事」；
//   · 与本会话已有的发言按文本去重，不重复；
//   · 只给事实和许可，不替她组织说法（「这是你自己说的，说不说、怎么说由你」）。

/**
 * @param {Array<object>} entries 记忆库条目（kind=utterance，可含 scope/key/time/text）
 * @param {{key?: string, now?: number, maxAgeMs?: number, maxLines?: number, allowPrivate?: boolean, allowGroup?: boolean}} opts
 * @returns {string} 空串 = 没有可递的
 */
export function renderSelfRecent(entries, {
  key = '',
  now = Date.now(),
  maxAgeMs = 3 * 3600 * 1000,
  maxLines = 3,
  // 默认与记忆召回一致：群聊不读私聊（防泄漏），私聊可以读群（她自己的话）。
  allowPrivate = false,
  allowGroup = true,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const selfKey = String(key ?? '');
  const selfIsGroup = selfKey.startsWith('group:');
  const seen = new Set();
  const picked = [];
  for (let i = list.length - 1; i >= 0 && picked.length < maxLines; i -= 1) {
    const e = list[i];
    if (!e || !e.text) continue;
    if (e.kind !== 'utterance') continue;
    // 本会话里说过的话不重复递（她能在最近上下文里看到）
    if (selfKey && String(e.key ?? '') === selfKey) continue;
    const entryIsGroup = String(e.key ?? '').startsWith('group:');
    if (selfIsGroup && !entryIsGroup && !allowPrivate) continue;
    if (!selfIsGroup && entryIsGroup && !allowGroup) continue;
    const t = Number(e.time) || Date.parse(String(e.at ?? '')) || 0;
    if (!t || now - t > maxAgeMs || now - t < 0) continue;
    const text = String(e.text).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const where = String(e.key ?? '').startsWith('group:') ? `群${String(e.key).split(':')[1]}` : '私聊';
    picked.push(`${hm}（${where}）${text}`);
  }
  if (!picked.length) return '';
  picked.reverse(); // 按时间正序
  return [
    '【你最近在别处说过的事（不是这个会话里）】',
    ...picked,
    '（这些是你自己说的。有人问起就按这个答；上面没有的，就是你没做过——别认。）',
  ].join('\n');
}
