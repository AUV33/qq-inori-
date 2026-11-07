// [CONTROL-ROOM] 中控台：把"她现在同时在处理哪些场面"压成一小段注入提示
// 目的：她同时跑多个会话/后台任务时，自己知道都在干什么（谁在等她、谁有未读、几个回合在跑）。
// 纪律：纯函数、只陈述事实（谁在等、几条未读、多久前），不替她决定先回谁；总长有上限。

const MIN = 60_000;
const HOUR = 60 * MIN;

function ago(ms, now = Date.now()) {
  if (!ms) return '无';
  const d = Math.max(0, now - ms);
  if (d < MIN) return '刚刚';
  if (d < HOUR) return `${Math.round(d / MIN)} 分钟前`;
  return `${Math.round(d / HOUR)} 小时前`;
}

function labelOf(scene) {
  if (scene.kind === 'private') return `私聊 ${scene.id}`;
  if (scene.kind === 'group') return `群 ${scene.id}`;
  return scene.id;
}

/**
 * @param {object[]} scenes [{id, kind, unread, lastIncomingAt, lastSpokeAt, running, pending, note}]
 * @param {{currentKey?:string, activeTurns?:number, maxTurns?:number, queued?:number, now?:number, maxChars?:number}} opts
 */
export function renderControlRoom(scenes, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const maxChars = Math.max(120, Number(opts.maxChars) || 320);
  const currentKey = String(opts.currentKey || '');
  const list = (Array.isArray(scenes) ? scenes : [])
    .filter((s) => s && s.id)
    .filter((s) => (s.unread > 0) || (s.running) || (Number(s.lastIncomingAt) || 0) > now - 6 * HOUR || (Number(s.lastSpokeAt) || 0) > now - 6 * HOUR)
    .slice(0, 6);

  const head = `【我手上同时有这些】`;
  const lines = [];
  for (const s of list) {
    const bits = [];
    if (Number(s.unread) > 0) bits.push(`${s.unread} 条没看（${ago(s.lastIncomingAt, now)}）`);
    else bits.push(`静（上次来信 ${ago(s.lastIncomingAt, now)}）`);
    if (s.running) bits.push('回合在跑');
    if (Number(s.pending) > 0) bits.push(`还有 ${s.pending} 个唤醒在排`);
    if (String(s.id) === currentKey || String(s.key || '') === currentKey || (currentKey && currentKey.endsWith(`:${s.id}`))) bits.push('就是这儿');
    if (s.note) bits.push(String(s.note).slice(0, 24));
    lines.push(`· ${labelOf(s)}：${bits.join('，')}`);
  }

  const busy = [];
  const activeTurns = Number(opts.activeTurns);
  const maxTurns = Number(opts.maxTurns);
  if (Number.isFinite(activeTurns) && Number.isFinite(maxTurns) && maxTurns > 0) busy.push(`回合 ${activeTurns}/${maxTurns}`);
  if (Number(opts.queued) > 0) busy.push(`${opts.queued} 个在排队`);
  if (Array.isArray(opts.background) && opts.background.length) busy.push(`后台在跑：${opts.background.slice(0, 4).join('、')}`);

  const tail = busy.length ? `（${busy.join('；')}；先看谁、先回谁你定）` : '（先看谁、先回谁你定）';
  let text = [head, ...lines, tail].join('\n');
  if (text.length > maxChars) {
    // 超长就只留"有未读/在跑"的场景，仍超就硬截
    const kept = lines.filter((l) => /条没看|回合在跑|在排/.test(l));
    text = [head, ...kept, tail].join('\n');
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
  }
  return text;
}

/** 从 bridge 的原始状态拼 scenes（保持可测：不读文件，只吃数据） */
export function buildScenes(conversations, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const runningKeys = new Set(Array.isArray(opts.runningKeys) ? opts.runningKeys : []);
  const out = [];
  for (const [key, st] of Object.entries(conversations || {})) {
    if (!st) continue;
    const unread = Array.isArray(st.unread) ? st.unread.length : 0;
    const lastIn = Number(st.lastIncomingAt) || 0;
    const lastSpoke = Number(st.lastAiReplyAt) || 0;
    if (!unread && !runningKeys.has(key) && lastIn < now - 6 * HOUR && lastSpoke < now - 6 * HOUR) continue;
    out.push({
      id: key.includes(':') ? key.split(':').slice(1).join(':') : key,
      key,
      kind: key.startsWith('private:') ? 'private' : 'group',
      unread,
      lastIncomingAt: lastIn,
      lastSpokeAt: lastSpoke,
      running: runningKeys.has(key),
      pending: Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0,
    });
  }
  // 有未读/在跑的排前面，其次按最近来信
  out.sort((a, b) => (Number(b.unread > 0) + Number(b.running)) - (Number(a.unread > 0) + Number(a.running)) || b.lastIncomingAt - a.lastIncomingAt);
  return out;
}


/** [CONTROL-ROOM] 只给"调度事实"一行：会话语义清单由 inori-sessions 的【你手头的会话】负责，避免重复 */
export function renderOpsLine({ activeTurns, maxTurns, queued, background } = {}) {
  const bits = [];
  const a = Number(activeTurns);
  const m = Number(maxTurns);
  if (Number.isFinite(a) && Number.isFinite(m) && m > 0) bits.push(`回合 ${a}/${m}`);
  if (Number(queued) > 0) bits.push(`${queued} 个在排队`);
  if (Array.isArray(background) && background.length) bits.push(`后台在跑：${background.slice(0, 4).join('、')}`);
  if (!bits.length) return '';
  return `【调度】${bits.join('；')}（先看谁、先回谁你定）`;
}
