// inori-discourse-state.js · 会话语境界（纯函数，零 IO）
//
// PragmaticFrame 只说“这一句”；DiscourseState 说“它在这段对话的哪里”。
// 只维护短窗口事实：当前话题、还没答的问题、还没接的搭话、最近回调。
// 不判断谁对谁错，不给她派任务。

function clean(s, max = 60) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createDiscourseState() {
  return {
    topic: '',
    openQuestions: [],
    openBids: [],
    callbacks: [],
    updatedAt: 0,
  };
}

export function updateDiscourseState(state, frame = {}, { text = '', speaker = '', now = Date.now() } = {}) {
  const s = state && typeof state === 'object' ? { ...state } : createDiscourseState();
  s.openQuestions = Array.isArray(s.openQuestions) ? s.openQuestions.slice(-5) : [];
  s.openBids = Array.isArray(s.openBids) ? s.openBids.slice(-5) : [];
  s.callbacks = Array.isArray(s.callbacks) ? s.callbacks.slice(-5) : [];
  const body = clean(text, 80);
  if (body && frame.speechAct !== 'question') s.topic = body;
  if (frame.speechAct === 'question') {
    s.openQuestions.push({ text: body, speaker: String(speaker || ''), at: now });
    if (s.openQuestions.length > 5) s.openQuestions.shift();
  }
  if (frame.speechAct === 'bid') {
    s.openBids.push({ text: body, speaker: String(speaker || ''), at: now });
    if (s.openBids.length > 5) s.openBids.shift();
  }
  if (frame.speechAct === 'statement' && /上次|之前|还记得|那次/.test(body)) {
    s.callbacks.push({ text: body, at: now });
    if (s.callbacks.length > 5) s.callbacks.shift();
  }
  s.updatedAt = now;
  return s;
}

export function renderDiscourseBlock(state, { limit = 2 } = {}) {
  if (!state || typeof state !== 'object') return '';
  const lines = [];
  if (state.topic) lines.push(`【现在的话题】${clean(state.topic, 60)}`);
  const qs = Array.isArray(state.openQuestions) ? state.openQuestions.slice(-limit) : [];
  if (qs.length) lines.push(`【还没答的】${qs.map((q) => clean(q.text, 40)).join('；')}`);
  const bids = Array.isArray(state.openBids) ? state.openBids.slice(-limit) : [];
  if (bids.length) lines.push(`【像在等你接】${bids.map((b) => clean(b.text, 40)).join('；')}`);
  return lines.join('\n');
}
