// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  pendingJudgeList,
  judgeSlangEntry,
  renderSlangJudgeLine,
  SLANG_STATUS,
} from '../src/domain/social/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// 6. pendingJudgeList：只列「研究出含义 + 仍是候选」的词，按出现次数倒序（同频次按 updatedAt 倒序），并递 count 事实
{
  const entries = [
    { id: '1', content: 'wc', meaning: '卧槽', status: SLANG_STATUS.CANDIDATE, updatedAt: '2026-10-25T01:00:00Z', count: 3, evidence: [{ sender: 'M', text: 'wc 这操作' }] },
    { id: '2', content: '666', meaning: '', status: SLANG_STATUS.CANDIDATE, updatedAt: '2026-10-25T02:00:00Z' },
    { id: '3', content: '土鳖', meaning: '老土', status: SLANG_STATUS.CANDIDATE, updatedAt: '2026-10-25T03:00:00Z', count: 1, evidence: [] },
    { id: '4', content: '绝密', meaning: '机密', status: SLANG_STATUS.CONFIRMED, updatedAt: '2026-10-25T04:00:00Z' },
  ];
  const pending = pendingJudgeList(entries, 8);
  // wc(3次) 排最前；土鳖(1次、研究更晚) 次之；无含义的 666 与已确认的绝密都不进队列
  assert.deepEqual(pending.map((e) => e.content), ['wc', '土鳖']);
  assert.equal(pending[0].count, 3, '递 count 事实：出现次数');
  assert.equal(pending[1].count, 1);
  assert.equal(pending[0].evidence.who, 'M');
  assert.equal(pending[1].evidence, null, '无证据的返回 null 证据');
  ok('pendingJudgeList 过滤/排序正确');
}

// 7. judgeSlangEntry confirm：必须有含义才许确认；确认后置 CONFIRMED + 留痕
{
  const noMeaning = [{ id: '1', content: '666', meaning: '', status: SLANG_STATUS.CANDIDATE }];
  const r1 = judgeSlangEntry(noMeaning, '666', 'confirm');
  assert.match(r1.error, /还没有研究出含义/);
  assert.equal(r1.entry.status, SLANG_STATUS.CANDIDATE, '拒绝放行：含义缺失时不改状态');

  const withMeaning = [{ id: '2', content: 'wc', meaning: '卧槽', status: SLANG_STATUS.CANDIDATE }];
  const r2 = judgeSlangEntry(withMeaning, 'wc', 'confirm');
  assert.equal(r2.error, null);
  assert.equal(r2.entry.status, SLANG_STATUS.CONFIRMED);
  assert.ok(r2.entry.agentConfirmedAt, '留痕：确认是她点的头');
  assert.equal(withMeaning[0].status, SLANG_STATUS.CANDIDATE, '纯函数：不改入参（原对象仍是候选）');
  ok('judgeSlangEntry confirm 语义正确');
}

// 8. judgeSlangEntry reject：候选可放下；终态不可再判；不存在的词报错
{
  const entries = [{ id: '1', content: 'wc', meaning: '卧槽', status: SLANG_STATUS.CANDIDATE }];
  const r1 = judgeSlangEntry(entries, 'wc', 'reject');
  assert.equal(r1.error, null);
  assert.equal(r1.entry.status, SLANG_STATUS.REJECTED);
  assert.ok(r1.entry.agentRejectedAt);
  const r2 = judgeSlangEntry(r1.entries, 'wc', 'confirm');
  assert.match(r2.error, /放下了/);
  const r3 = judgeSlangEntry(r1.entries, '没有这个词', 'reject');
  assert.match(r3.error, /词库里没有/);
  ok('judgeSlangEntry reject/终态/查无此词');
}

// 9. renderSlangJudgeLine：空队列 null；非空给事实+许可，不催
{
  assert.equal(renderSlangJudgeLine([]), null);
  assert.equal(renderSlangJudgeLine([{ content: 'wc', meaning: '', status: SLANG_STATUS.CANDIDATE }]), null);
  const line = renderSlangJudgeLine([
    { content: 'wc', meaning: '卧槽', status: SLANG_STATUS.CANDIDATE, updatedAt: '2026-10-25T02:00:00Z' },
    { content: '666', meaning: '溜', status: SLANG_STATUS.CANDIDATE, updatedAt: '2026-10-25T03:00:00Z' },
  ], 8);
  assert.ok(/2\s*个词/.test(line) || /词库里有\s*2\s*个/.test(line), '报数量');
  assert.ok(line.includes('qq_slang_judge'), '给工具名');
  assert.ok(line.includes('confirm') && line.includes('reject'), '两条路都给她');
  assert.ok(line.includes('不想看就让它放着'), '许可里含「可以不看」');
  ok('renderSlangJudgeLine 事实+许可、空则 null');
}

// 10. normalizeSlangEntry 保留她的判定留痕字段
{
  const e = normalizeSlangEntry({ content: 'wc', status: SLANG_STATUS.CONFIRMED, agentConfirmedAt: '2026-10-25T05:00:00Z' });
  assert.equal(e.agentConfirmedAt, '2026-10-25T05:00:00Z');
  const e2 = normalizeSlangEntry({ content: 'wc', status: SLANG_STATUS.CANDIDATE });
  assert.ok(!('agentConfirmedAt' in e2), '没有留痕就不留字段');
  ok('normalizeSlangEntry 保留/省略判定留痕');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
