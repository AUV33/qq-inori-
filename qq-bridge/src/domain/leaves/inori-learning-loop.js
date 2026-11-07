// [LEARN-LOOP] 学习账本：把“学过的词有没有被用、注入的经验有没有跑完、技能有没有结果”
// 变成可机检的数据，并在夜间反思时递给她自己看（事实 + 许可，不派活、不替她改）。
import fs from 'node:fs';
import path from 'node:path';
import { bridgePath, stateDataPath } from '../shared/project-paths.js';
import { readJsonl as readJsonlShared } from './jsonl.mjs';

export const DEFAULT_PATHS = {
  slang: bridgePath('state', 'slang.json'),
  skills: stateDataPath('skills.json'),
  lessonUsage: stateDataPath('lesson-usage.jsonl'),
  feedback: stateDataPath('learning-feedback.jsonl'),
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) { return readJsonlShared(file); }

function appendJsonl(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-learning-loop.js:30'); }
}

/** 从她的出站文本里找已确认黑话；只命中长度≥2 的词，避免单字噪声。 */
export function findConfirmedTerms(text, entries) {
  const body = String(text ?? '');
  if (!body) return [];
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e?.status === 'confirmed' && typeof e.content === 'string' && e.content.length >= 2)
    .map((e) => e.content)
    .filter((term) => body.includes(term));
}

// 同一进程内按“词+日期”去重，避免她连发多条时把同一词记成几十次。
const usageSeen = new Map();

export function recordSlangUsage(entries, key, text, at = Date.now(), feedbackFile = DEFAULT_PATHS.feedback) {
  const hits = findConfirmedTerms(text, entries);
  if (!hits.length) return 0;
  const day = new Date(at).toISOString().slice(0, 10);
  let added = 0;
  for (const term of hits) {
    const id = `${feedbackFile}|${day}|${term}`;
    if (usageSeen.has(id)) continue;
    usageSeen.set(id, true);
    appendJsonl(feedbackFile, { at: new Date(at).toISOString(), type: 'slang_used', term, key: String(key ?? '') });
    added += 1;
  }
  return added;
}

/** 技能回合结果：注入过的技能这一轮是完成、中断还是出错（不冒充“技能成功”）。 */
export function recordSkillAttempt(ids, outcome, key, at = Date.now(), feedbackFile = DEFAULT_PATHS.feedback) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return 0;
  appendJsonl(feedbackFile, { at: new Date(at).toISOString(), type: 'skill_attempt', ids: list, outcome: String(outcome ?? 'unknown'), key: String(key ?? '') });
  return list.length;
}

/**
 * 经验效果代理指标：本回合注入过的经验 → 回合结果记到 lesson-usage.jsonl。
 * 与 mux-bus 里生产路径写入的字段形状一致（{at,key,ids,outcome}），便于统一度量；
 * 这不是因果证明，只是可机检的观察数据（哪条经验被用过的回合完成率更高）。
 * @returns 写入的 id 数（0 表示没有 id，不写）
 */
export function recordLessonUsage(ids, outcome, key, at = Date.now(), usageFile = DEFAULT_PATHS.lessonUsage) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return 0;
  appendJsonl(usageFile, { at: new Date(at).toISOString(), key: String(key ?? ''), ids: list, outcome: String(outcome ?? 'unknown') });
  return list.length;
}

/** 汇总最近 N 天的学习账本；纯读文件，不改任何数据。 */
export function summarizeLearning(days = 7, now = Date.now(), paths = {}) {
  const p = { ...DEFAULT_PATHS, ...paths };
  const cutoff = now - Math.max(1, Number(days) || 7) * 86400000;
  const slang = readJson(p.slang, []);
  const entries = Array.isArray(slang) ? slang : [];
  const confirmed = entries.filter((e) => e?.status === 'confirmed');
  const candidates = entries.filter((e) => e?.status === 'candidate');
  const pendingWithMeaning = candidates.filter((e) => String(e?.meaning ?? '').trim()).length;

  const feedback = readJsonl(p.feedback).filter((r) => {
    const t = Date.parse(r?.at || '');
    return Number.isFinite(t) && t >= cutoff;
  });
  const usedTerms = new Set(feedback.filter((r) => r.type === 'slang_used').map((r) => r.term).filter(Boolean));

  const usage = readJsonl(p.lessonUsage).filter((r) => {
    const t = Date.parse(r?.at || '');
    return Number.isFinite(t) && t >= cutoff;
  });
  const lessonOutcomes = { completed: 0, aborted: 0, error: 0, other: 0 };
  for (const r of usage) {
    const k = ['completed', 'aborted', 'error'].includes(r?.outcome) ? r.outcome : 'other';
    lessonOutcomes[k] += 1;
  }
  const lessonTotal = usage.length;
  const lessonCompletedRate = lessonTotal ? lessonOutcomes.completed / lessonTotal : 0;

  const store = readJson(p.skills, {});
  const skills = Array.isArray(store?.items) ? store.items : [];
  const skillAttempts = feedback.filter((r) => r.type === 'skill_attempt');
  const skillCompleted = skillAttempts.filter((r) => r.outcome === 'completed').length;

  return {
    days,
    slang: {
      total: entries.length,
      confirmed: confirmed.length,
      candidates: candidates.length,
      pendingWithMeaning,
      usedTerms: usedTerms.size,
      usedSample: [...usedTerms].slice(0, 5),
    },
    lessons: { total: lessonTotal, outcomes: lessonOutcomes, completedRate: lessonCompletedRate },
    skills: {
      total: skills.length,
      injected: skills.reduce((n, s) => n + (Number(s?.injected) || 0), 0),
      success: skills.reduce((n, s) => n + (Number(s?.success) || 0), 0),
      fail: skills.reduce((n, s) => n + (Number(s?.fail) || 0), 0),
      withVerify: skills.filter((s) => String(s?.verify ?? '').trim()).length,
      attempts: skills.reduce((n, s) => n + (Number(s?.attempts) || 0), 0),
      degraded: skills.filter((s) => s?.degraded).length,
      windowAttempts: skillAttempts.length,
      completed: skillCompleted,
    },
  };
}

/** 夜间反思末尾的事实块：只给账本 + 许可，不命令她“必须学/必须删”。 */
export function renderLearningDigest(stats) {
  const s = stats?.slang || {};
  const l = stats?.lessons || {};
  const k = stats?.skills || {};
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
  const lines = [
    `【学习账本·最近${Number(stats?.days) || 7}天】`,
    `黑话：共 ${s.total ?? 0} 条（已确认 ${s.confirmed ?? 0} / 待判 ${s.candidates ?? 0}，其中有释义 ${s.pendingWithMeaning ?? 0}）；最近说过的已确认词 ${s.usedTerms ?? 0} 个${s.usedSample?.length ? `（${s.usedSample.join('、')}）` : ''}`,
    // [LABEL] 这个数字是"回合正常收尾"（reason.kind=completed），不是"经验被用对了"。
    // 旧文案"跑完"容易被读成成功率，改成明确口径。
    `经验：注入 ${l.total ?? 0} 次，回合正常收尾 ${l.outcomes?.completed ?? 0}（${pct(l.completedRate)}），中断 ${l.outcomes?.aborted ?? 0}，出错 ${l.outcomes?.error ?? 0}`,
    `技能：${k.total ?? 0} 条（有验证说明 ${k.withVerify ?? 0}，降级 ${k.degraded ?? 0}），注入 ${k.injected ?? 0} 次，尝试 ${k.attempts ?? 0}，成功/失败 ${k.success ?? 0}/${k.fail ?? 0}；本窗口注入回合 ${k.windowAttempts ?? 0}，完成 ${k.completed ?? 0}`,
    '这些只是账本；用过的词、跑完的经验可以留着，总用不上/总被中断的可以改写或放下——你定。',
  ];
  return lines.join('\n');
}
