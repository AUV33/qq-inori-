import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentPrompt, summarizePrompt, budgetWarnings, formatBudgetLine, compactInjection, mergeBlocks, SAFE_INJECTION_CAPS, enforceInjectionBudget, planTierBudget, planTierBudgets, SCENE_BUDGETS, INJECTION_RESERVE, LEGACY_TIER_MAX } from '../src/domain/persona/prompt-budget.js';

test('segmentPrompt：按【标题】切块，基底单独算，同名块合并', () => {
  const text = '前置说明。【角色】abc【记忆】0123456789【记忆】xx';
  const seg = segmentPrompt(text);
  assert.equal(seg.total, text.length);
  assert.equal(seg.blocks[0].label, '基底');
  assert.equal(seg.blocks[0].chars, '前置说明。'.length);
  const mem = seg.blocks.find((b) => b.label === '记忆');
  assert.ok(mem.chars > 10, '同名块应合并');
  assert.equal(seg.blockCount, 3);
});

test('segmentPrompt：没有标题时整段算一块（不报错）', () => {
  const seg = segmentPrompt('没有任何标题的纯文本');
  assert.equal(seg.total, '没有任何标题的纯文本'.length);
  assert.deepEqual(seg.blocks, []);
  assert.equal(seg.blockCount, 0);
});

test('summarizePrompt：按占比排序，top 可配', () => {
  const text = '【小】1\n【大】' + 'x'.repeat(100);
  const s = summarizePrompt(text, { top: 2 });
  assert.equal(s.top[0].label, '大');
  assert.ok(s.top[0].pct > 80);
});

test('summarizePrompt：只认行首标题，正文里的【他】不切块（角色卡度量回归）', () => {
  const text = `【当前角色】\n群里只有带【他】标记的才是他本人（QQ 1）。\n${'x'.repeat(120)}`;
  const s = summarizePrompt(text, { top: 5 });
  const role = s.blocks.find((b) => b.label === '当前角色');
  assert.ok(role, '当前角色应是一整块');
  assert.ok(role.chars > 130, `整卡不该被正文里的【他】切走，实际 ${role.chars}`);
  assert.equal(s.blocks.some((b) => b.label === '他'), false, '正文里的【他】不是块标题');
});

test('budgetWarnings：总长/单块/块数三类告警', () => {
  const text = '【大】' + 'x'.repeat(2500);
  const s = summarizePrompt(text);
  const w = budgetWarnings(s, { maxTotal: 100, maxBlock: 1000, maxBlocks: 1 });
  assert.ok(w.some((x) => x.includes('总长')));
  assert.ok(w.some((x) => x.includes('块【大】')));
  assert.ok(formatBudgetLine(s).includes('总'));
  assert.deepEqual(budgetWarnings(null), []);
});

// ── [TOKEN-DIET] 注入瘦身 ─────────────────────────────────────────────────

test('compactInjection：同义块合并成一个规范块', () => {
  const text = '【对群友的印象】\n甲\n\n【群友的印象】\n乙\n\n【这个群里的人】\n丙\n';
  const r = compactInjection(text);
  assert.equal((r.text.match(/【对群友的印象】/g) || []).length, 1);
  assert.equal(r.text.includes('【群友的印象】'), false);
  assert.equal(r.text.includes('【这个群里的人】'), false);
  assert.ok(r.text.includes('甲') && r.text.includes('乙') && r.text.includes('丙'), '合并不能丢内容');
});

test('compactInjection：超配额的长尾块被截断并标 …', () => {
  const text = `【对群友的印象】\n${'印象'.repeat(800)}\n`;
  const r = compactInjection(text);
  assert.ok(r.after < r.before);
  assert.deepEqual(r.trimmed, ['对群友的印象']);
  assert.ok(r.text.endsWith('…\n'));
});

test('compactInjection：事实块（消息快照/未读/时间）绝不截断', () => {
  const snapshot = `【本次消息快照】\n${'消息'.repeat(4000)}\n`;
  const unread = `【未读】\n${'未'.repeat(2000)}\n`;
  const time = `【当前时间】\n${'时'.repeat(500)}\n`;
  const r = compactInjection(snapshot + unread + time);
  assert.equal(r.after, r.before);
  assert.deepEqual(r.trimmed, []);
  assert.ok(r.text.includes('消息'.repeat(4000)));
});

test('compactInjection：不超配额时原样返回（幂等）', () => {
  const text = '【你自己】\n短\n';
  const r = compactInjection(text);
  assert.equal(r.text, text);
  assert.equal(compactInjection(r.text).text, r.text);
});

test('SAFE_INJECTION_CAPS：只削背景长尾，人设与事实块永不截断', () => {
  const card = `【当前角色】\n${'人设'.repeat(2000)}\n`;
  const self = `【你自己】\n${'自述'.repeat(2000)}\n`;
  const longTail = `【对群友的印象】\n${'印象'.repeat(800)}\n`;
  const r = compactInjection(card + self + longTail, { caps: SAFE_INJECTION_CAPS, mergeGroups: [] });
  // 人设两块原样保留（2026-10-28 的教训：截人设会让发言变差）
  assert.ok(r.text.includes('人设'.repeat(2000)), '当前角色被截了');
  assert.ok(r.text.includes('自述'.repeat(2000)), '你自己被截了');
  // 背景长尾被截，且只报这一块
  assert.deepEqual(r.trimmed, ['对群友的印象']);
  assert.ok(r.after < r.before);
});

test('mergeBlocks：同义块合并成一个（标题以规范组为准）', () => {
  const text = '【群里的人】\nA\n\n【群友的印象】\nB\n';
  const merged = mergeBlocks(text);
  // 规范组现在叫「群里的动静」，并把同义块收成要点；契约是"只留一个块 + 内容不丢"。
  assert.equal((merged.match(/【群里的动静】/g) || []).length, 1, '同义块只留一个规范块');
  assert.ok(merged.includes('A') && merged.includes('B'), '合并不能丢内容');
});

test('enforceInjectionBudget：超限先丢长尾，保护块不动', () => {
  const text = [
    '【当前角色】人设不能丢',
    '【群聊黑话表】' + '黑'.repeat(200),
    '【表情包】' + '表'.repeat(200),
    '【本次消息快照】' + '消息'.repeat(100),
    '【收尾】必须留',
  ].join('\n');
  const r = enforceInjectionBudget(text, 120);
  assert.ok(r.dropped.includes('群聊黑话表'));
  assert.ok(r.text.includes('【当前角色】'));
  assert.ok(r.text.includes('【本次消息快照】'));
  assert.ok(r.text.includes('【收尾】'));
  assert.ok(!r.text.includes('【群聊黑话表】'));
});

test('enforceInjectionBudget：预算够时原样返回', () => {
  const text = '【你自己】短';
  const r = enforceInjectionBudget(text, 1000);
  assert.equal(r.text, text);
  assert.equal(r.over, false);
});

// ── 分层预算（实测动态）：2026-11-03 的线上事实是 core+ref 10.6k，旧 7600 把装饰层裁光 ──
test('planTierBudget：基底很小的时候仍用旧口径 7600 兜底', () => {
  const p = planTierBudget({ coreLen: 2000, refLen: 1200, sceneBudget: SCENE_BUDGETS.private, decoFloor: 600 });
  assert.equal(p.ceiling, LEGACY_TIER_MAX);
  assert.equal(p.mode, 'legacy');
});

test('planTierBudget：基底超旧上限时，按实测给装饰层留位置（2026-11-03 的 10.6k 场景）', () => {
  const base = 10645;
  const p = planTierBudget({ coreLen: base - 2000, refLen: 2000, sceneBudget: SCENE_BUDGETS.private, decoFloor: 600 });
  assert.equal(p.base, base);
  assert.equal(p.ceiling, base + 600, '应该给装饰层 600 字');
  assert.equal(p.mode, 'measured');
  assert.ok(p.ceiling < SCENE_BUDGETS.private - INJECTION_RESERVE + 1, '不能超过场景预算减注入预留');
});

test('planTierBudget：她调成 0 就只保基底，调大就多给（不超过场景预算）', () => {
  const base = 9000;
  assert.equal(planTierBudget({ coreLen: base, refLen: 0, decoFloor: 0, sceneBudget: SCENE_BUDGETS.private }).ceiling, base);
  const big = planTierBudget({ coreLen: base, refLen: 0, decoFloor: 2000, sceneBudget: SCENE_BUDGETS.private });
  assert.equal(big.ceiling, base + 2000);
  const capped = planTierBudget({ coreLen: 13000, refLen: 0, decoFloor: 2000, sceneBudget: SCENE_BUDGETS.private });
  assert.equal(capped.ceiling, 13000, '场景预算放不下时以基底为准，不凭空加');
});

test('planTierBudget：群聊预算更紧（9000−1500），装饰层不会撑破群预算', () => {
  const p = planTierBudget({ coreLen: 7000, refLen: 0, decoFloor: 600, sceneBudget: SCENE_BUDGETS.group });
  assert.ok(p.ceiling <= SCENE_BUDGETS.group - INJECTION_RESERVE, `群聊上限 ${p.ceiling} 超了`);
  assert.ok(p.ceiling >= 7000, '基底必须放得下');
});
test('planTierBudgets：core 拿固定份额、ref 拿剩下的、deco 有保底', () => {
  const p = planTierBudgets({ coreLen: 5000, refLen: 3000, sceneBudget: 14000, reserve: 1500, decoFloor: 600 });
  assert.equal(p.usable, 12500);
  assert.equal(p.coreCap, 7500);
  assert.equal(p.refCap, 5000);
  assert.ok(p.decoCap >= 600);
  assert.equal(p.exceeded.core, false);
  assert.equal(p.exceeded.base, false);
});

test('planTierBudgets：core 超份额 / 基底超可用空间时标红', () => {
  const p = planTierBudgets({ coreLen: 9000, refLen: 4000, sceneBudget: 14000, reserve: 1500 });
  assert.equal(p.exceeded.core, true);
  assert.equal(p.exceeded.base, true);
});

