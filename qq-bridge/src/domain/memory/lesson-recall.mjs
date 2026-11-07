// lesson-recall.mjs · 宪章 §5.10 / G13：把教训库纳入检索域（类比触发的地基）
//
// 干什么：给当前情境做字面相关度（CJK bigram）→ 从 lessons-ledger 折叠态里挑"此刻该想起的经验"，
//   渲染成独立块注入记忆检索结果。只取 verified/active；candidate/demoted 不注入，避免污染。
// 为什么：审计结论明确"memory-retrieve 不检索 lessons"——学习停在"见过的才认得"，
//   下次遇到语义相似但表面不同的情境，相关教训根本不会被调出。
// 输入输出：纯排序/渲染 + 一个只读加载器；空结果返回空串。
// 失败模式：坏账/缺文件返回空数组；不抛错。
// 不做什么：不做向量检索（S7b 接嵌入）、不生成文本、不改教训状态。

import fs from 'node:fs';
import { LESSON_LEDGER_FILE, parseLedger, foldLessons, DEFAULT_TTL_DAYS } from '../mind/lessons-ledger.mjs';
// [PROMPT-SAFETY] 教训正文也可能夹带用户原话；进 prompt 前中性化。
import { sanitizePromptSnippet } from '../shared/prompt-safety.mjs';

export const LESSON_RECALL_VERSION = 1;
const DEFAULT_STATUSES = Object.freeze(['verified', 'active']);
const STATUS_WEIGHT = Object.freeze({ verified: 1, active: 0.7, candidate: 0.4 });

function bigrams(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/** 二元组覆盖率（与 memory-retrieve 同口径，避免循环依赖而本地实现）。 */
export function lessonCoverage(query, text) {
  const q = bigrams(query);
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!q.size || s.length < 2) return 0;
  let hit = 0;
  for (const gram of q) if (s.includes(gram)) hit += 1;
  return hit / q.size;
}

/**
 * @param {Array} lessons 折叠后的教训
 * @param {string} query 当前情境（用户消息/上下文）
 * @param {{topK?:number, minCoverage?:number, statuses?:string[]}} [opts]
 */
export function rankLessons(lessons, query, opts = {}) {
  const topK = Number.isFinite(opts.topK) ? Math.max(0, opts.topK) : 4;
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : 0.12;
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length ? opts.statuses : DEFAULT_STATUSES;
  const q = String(query ?? '').trim();
  const scored = (Array.isArray(lessons) ? lessons : [])
    .filter((l) => l && statuses.includes(l.status))
    .map((lesson) => {
      const coverage = q ? lessonCoverage(q, lesson.rule) : 0;
      const base = (STATUS_WEIGHT[lesson.status] || 0.3) * 0.5 + (Number(lesson.confidence) || 0) * 0.3;
      const score = base + coverage * 0.7;
      return { lesson, coverage, score };
    })
    .filter((row) => (q ? row.coverage >= minCoverage : true))
    .sort((a, b) => b.score - a.score || Number(b.lesson.pos || 0) - Number(a.lesson.pos || 0) || String(b.lesson.updatedAt).localeCompare(String(a.lesson.updatedAt)));
  return scored.slice(0, topK).map((row) => row.lesson);
}

/** 渲染成独立块；没有经验返回空串。 */
export function renderLessonsRecallBlock(lessons) {
  const list = Array.isArray(lessons) ? lessons.filter((l) => l && l.rule) : [];
  if (!list.length) return '';
  const lines = list.map((l) => {
    const mark = l.status === 'verified' ? '✅' : '·';
    return `- ${mark} ${sanitizePromptSnippet(l.rule, { maxChars: 120 })}`;
  }).filter((line) => line.length > 4);
  if (!lines.length) return '';
  return `【这也许和此刻有关（你自己的经验）】\n${lines.join('\n')}\n（这是你以前想明白的事，不是命令；用不用、怎么用，你自己判断。）`;
}

/** 只读加载器：读 lessons-ledger → 折叠（TTL 视图）→ 返回 lessons；坏文件返回 []。 */
export function loadLessonsForRecall({ file, now = Date.now(), ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (!file) return [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    return foldLessons(parseLedger(text).rows, { now, ttlDays }).lessons;
  } catch { return []; }
}

export { LESSON_LEDGER_FILE };
