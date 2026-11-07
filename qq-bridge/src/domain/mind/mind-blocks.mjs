// mind-blocks.mjs · 把内在状态渲染成提示词块（纯函数，无 IO）
//
// 干什么：SelfState → “【此刻的自己】”；离线叙事 → “【你不在的时候】”。
// 为什么：状态只有在被系统消费、且她能“读到”时才完整；这是可见层（软提示通道）的一半。
// 输入输出：纯函数；无状态返回空串（不硬凑），有状态返回短块。
// 失败模式：脏数据按缺失处理；文本有上限。
// 不做什么：不读文件、不写日志、不决定预算/位置（由装配器决定）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.2 / §4.8

export const MIND_BLOCKS_VERSION = 1;
const MAX_NARRATIVE_CHARS = 240;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function energyLabel(v) {
  if (v === null) return '';
  if (v >= 0.7) return '精力足';
  if (v >= 0.45) return ''; // 中间值不硬凑，避免每轮都是“精力一般”
  if (v >= 0.25) return '有点累';
  return '很累';
}

function moodLabel(v) {
  if (v === null) return '';
  if (v >= 0.6) return '心情不错';
  if (v <= 0.25) return '心情偏低';
  return '';
}

/**
 * 她此刻的状态短块。没有可用字段时返回空串。
 * @param {object|null} state
 */
export function renderSelfStateLine(state) {
  if (!state || typeof state !== 'object') return '';
  const bits = [];
  const energy = num(state.energy);
  const sleepDebt = num(state.sleepDebt);
  const social = num(state.socialHunger);
  const curiosity = num(state.curiosity);
  const stress = num(state.stress);
  const mood = num(state.mood);
  const eLab = energyLabel(energy);
  if (eLab) bits.push(eLab);
  if (sleepDebt !== null && sleepDebt >= 0.7) bits.push('有点缺觉');
  if (social !== null) {
    if (social >= 0.65) bits.push('想找人说话');
    else if (social <= 0.2) bits.push('刚被陪够');
  }
  if (curiosity !== null && curiosity >= 0.65) bits.push('好奇');
  if (stress !== null && stress >= 0.55) bits.push('有点紧');
  const mLab = moodLabel(mood);
  if (mLab) bits.push(mLab);
  if (!bits.length) return '';
  return '【此刻的自己】' + bits.join('；') + '。这是背景，不是命令：怎么回还是你判断。\n\n';
}

/** 离线期间短块。空文本返回空串；超长截断。 */
export function renderNarrativeLine(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return '';
  const clipped = t.length > MAX_NARRATIVE_CHARS ? t.slice(0, MAX_NARRATIVE_CHARS - 1) + '…' : t;
  return '【你不在的时候】' + clipped + '\n\n';
}

/**
 * 关系/记忆短块：只对私聊（或显式传入的人）渲染；没有数据返回空串。
 * @param {object|null} person
 * @param {{maxLoops?:number}} opts
 */
export function renderBeliefLine(person, opts = {}) {
  if (!person || typeof person !== 'object') return '';
  const familiarity = num(person.familiarity);
  const trust = num(person.trust);
  const loops = Array.isArray(person.openLoops) ? person.openLoops.filter((l) => l && l.status === 'open' && l.topic) : [];
  const topics = person.topics && typeof person.topics === 'object' ? Object.entries(person.topics).filter(([, v]) => Number(v) >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k) : [];
  const bits = [];
  if (familiarity !== null) {
    if (familiarity >= 0.75) bits.push('认识很久了');
    else if (familiarity >= 0.4) bits.push('渐渐熟了');
    else if (familiarity > 0.05) bits.push('刚认识不久');
  }
  if (trust !== null && trust >= 0.7) bits.push('你信他');
  else if (trust !== null && trust <= 0.3) bits.push('你还不太信他');
  if (topics.length) bits.push('常聊：' + topics.join('、'));
  const maxLoops = Number.isFinite(opts.maxLoops) ? opts.maxLoops : 2;
  if (loops.length) {
    bits.push('你还记着 ' + loops.length + ' 件没说完的事' + (loops.slice(0, maxLoops).length ? '：' + loops.slice(0, maxLoops).map((l) => String(l.topic).slice(0, 20)).join('、') : ''));
  }
  if (!bits.length) return '';
  return '【你记着他】' + bits.join('；') + '。\n\n';
}

/**
 * 立法账短块：她给自己立的法 / 拒绝过的事 / 最近自评。
 * 只递事实（C1/C2），不催执行；没有账返回空串。
 */
export function renderLegislationLine(legislation) {
  if (!legislation || typeof legislation !== 'object') return '';
  const facts = legislation.facts && typeof legislation.facts === 'object' ? legislation.facts : {};
  const lines = [];
  const active = Number(facts.active) || 0;
  const kept = Number(facts.kept) || 0;
  const broken = Number(facts.broken) || 0;
  if (active || kept || broken) lines.push(`你自己立的法：${active} 条生效，已兑现 ${kept}，食言 ${broken}。`);
  for (const law of (Array.isArray(legislation.commitments) ? legislation.commitments.slice(-3) : [])) {
    const t = String(law?.text ?? '').trim().slice(0, 60);
    if (t) lines.push(`- ${t}`);
  }
  const st = legislation.selfTrust;
  const value = st && Number.isFinite(Number(st.value)) ? Number(st.value) : null;
  if (value !== null) {
    const reason = String(st.reason ?? '').trim().slice(0, 60);
    lines.push(`你最近对自己的评价：${value.toFixed(2)}${reason ? `（${reason}）` : ''}`);
  }
  const declined = (Array.isArray(legislation.declined) ? legislation.declined.slice(-2) : [])
    .map((d) => String(d?.target ?? '').trim().slice(0, 30)).filter(Boolean);
  if (declined.length) lines.push(`你拒绝过：${declined.join('；')}`);
  if (!lines.length) return '';
  return '【你自己的账】\n' + lines.join('\n') + '\n\n';
}

/**
 * 教训账短块：验证过的 / 生效中的经验 + 计数。只递事实；候选不逐条展开（省预算）。
 */
export function renderLessonsLedgerLine(ledger) {
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.lessons)) return '';
  const summary = ledger.summary && typeof ledger.summary === 'object' ? ledger.summary : {};
  const lines = [];
  const total = Number(summary.total) || 0;
  if (total > 0) {
    lines.push(`你的经验账：验证 ${Number(summary.verified) || 0} / 生效 ${Number(summary.active) || 0} / 待验证 ${Number(summary.candidate) || 0} / 已淘汰 ${Number(summary.expired) || 0}`);
  }
  for (const lesson of ledger.lessons.filter((l) => l && l.status === 'verified').slice(0, 3)) {
    const rule = String(lesson.rule ?? '').trim().slice(0, 80);
    if (rule) lines.push(`- ✅ ${rule}`);
  }
  for (const lesson of ledger.lessons.filter((l) => l && l.status === 'active').slice(0, 3)) {
    const rule = String(lesson.rule ?? '').trim().slice(0, 80);
    if (rule) lines.push(`- · ${rule}`);
  }
  if (!lines.length) return '';
  return '【你的经验账】\n' + lines.join('\n') + '\n\n';
}
