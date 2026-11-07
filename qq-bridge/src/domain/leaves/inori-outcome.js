// inori-outcome.js · 选择后的结果账本（P0 学习闭环）
//
// 意图不是“许愿”——结束时要留下 expected/actual/result，下一次才知道
// “我上次这么选，结果是什么”。只记录事实，不评价她。
//
// 结果类型：success / partial / failed / abandoned。
// 失败不直接写成“经验”；先作为 outcome 留下，重复出现后再由 SelfReview 升级。

import fs from 'node:fs';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

const RESULTS = new Set(['success', 'partial', 'failed', 'abandoned']);

export function createOutcome({
  intentionId = '', expected = '', actual = '', result = 'partial', evidence = '', now = Date.now(),
} = {}) {
  return {
    at: new Date(now).toISOString(),
    intentionId: String(intentionId || ''),
    expected: String(expected ?? '').trim().slice(0, 240),
    actual: String(actual ?? '').trim().slice(0, 400),
    result: RESULTS.has(result) ? result : 'partial',
    evidence: String(evidence ?? '').trim().slice(0, 400),
  };
}

export function appendOutcome(file, row) {
  try {
    return appendJsonl(file, row, { source: 'outcomes' }).ok === true;
  } catch { return false; }
}

export function readOutcomes(file, { limit = 20 } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Number(limit) || 20));
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function summarizeOutcomes(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const by = {};
  for (const r of list) by[r?.result || 'unknown'] = (by[r?.result || 'unknown'] || 0) + 1;
  return { total: list.length, by };
}

export function renderOutcomesBlock(rows, { limit = 3 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(-Math.max(1, Number(limit) || 3));
  if (!list.length) return '';
  const lines = list.map((r) => {
    const expected = r.expected ? `想的是：${r.expected}` : '';
    const actual = r.actual ? `实际：${r.actual}` : '';
    return `- [${r.result}] ${[expected, actual].filter(Boolean).join('；') || '（无详情）'}`;
  });
  return `【最近的结果】\n${lines.join('\n')}`;
}
