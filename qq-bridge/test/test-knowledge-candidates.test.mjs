// [FROM-LOOKUP-TO-KNOW] 从查到记：候选挑选规则（纯函数）
//
// 判据是哨兵级的：只断言「几次算反复」「相似认知会不会压掉候选」「过期不出现」，
// 不测「她是不是更像人」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLookups, pickCandidates, renderCandidates, candidateText, parseArgs, subjectOf,
  DEFAULT_TTL_DAYS,
} from '../src/domain/leaves/inori-knowledge.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const call = (tool, args, minutesAgo, extra = {}) => ({
  type: 'call',
  tool,
  args: typeof args === 'string' ? args : JSON.stringify(args),
  time: new Date(NOW - minutesAgo * 60000).toISOString(),
  ...extra,
});

test('同一问题查 1 次不提议，查 2 次且间隔够久才提议', () => {
  const once = collectLookups([call('mcp__prts__get_stage_info', { stage_id: 'main_01-07' }, 10)], { now: NOW });
  assert.equal(once.length, 0);

  const twice = collectLookups([
    call('mcp__prts__get_stage_info', { stage_id: 'main_01-07' }, 120),
    call('mcp__prts__get_stage_info', { stage_id: 'main_01-07' }, 10),
  ], { now: NOW });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].hits, 2);
  assert.equal(twice[0].subject, 'main_01-07');
});

test('同一秒内的重复调用（重试/同回合连发）不算「反复查」', () => {
  const rows = [
    call('mcp__prts__get_stage_info', { stage_id: 'main_01-07' }, 0.2),
    call('mcp__prts__get_stage_info', { stage_id: 'main_01-07' }, 0.1),
  ];
  assert.equal(collectLookups(rows, { now: NOW }).length, 0);
});

test('只认事实类工具：search_prts / 别的 MCP 工具不进候选', () => {
  const rows = [
    call('mcp__prts__search_prts', { query: '能天使', search_mode: 'text' }, 120),
    call('mcp__prts__search_prts', { query: '能天使', search_mode: 'text' }, 10),
    call('mcp__phone__phone_look', { describe: true }, 120),
    call('mcp__phone__phone_look', { describe: true }, 10),
  ];
  assert.equal(collectLookups(rows, { now: NOW }).length, 0);
});

test('超过过期窗口的记录不算', () => {
  const rows = [
    call('mcp__prts__get_operator_basic_info', { name: '能天使' }, DEFAULT_TTL_DAYS * 1440 + 60),
    call('mcp__prts__get_operator_basic_info', { name: '能天使' }, DEFAULT_TTL_DAYS * 1440 + 1),
  ];
  assert.equal(collectLookups(rows, { now: NOW }).length, 0);
});

test('参数是双层转义的 JSON 字符串也能解出主体', () => {
  const doubled = JSON.stringify(JSON.stringify({ stage_id: 'easy_11-06' }));
  const args = parseArgs(doubled);
  assert.equal(subjectOf('mcp__prts__get_stage_info', args), 'easy_11-06');
});

test('已经写过相似认知的候选会被压掉', () => {
  const lookups = collectLookups([
    call('mcp__prts__get_stage_info', { stage_id: 'easy_11-06' }, 120),
    call('mcp__prts__get_stage_info', { stage_id: 'easy_11-06' }, 10),
  ], { now: NOW });
  assert.equal(lookups.length, 1);

  const written = [{ text: `关卡详情「easy_11-06」（查过 2 次）` }];
  assert.equal(pickCandidates(lookups, written).length, 0);
  assert.equal(pickCandidates(lookups, []).length, 1);
});

test('认知里只要出现同一主体（不去复述候选原话）也算写过', () => {
  const lookups = collectLookups([
    call('mcp__prts__get_operator_basic_info', { name: '能天使' }, 120),
    call('mcp__prts__get_operator_basic_info', { name: '能天使' }, 10),
  ], { now: NOW });
  assert.equal(lookups.length, 1);
  const written = [{ text: '能天使是六星狙击，三技能打群伤，费用 12', kind: 'about-world' }];
  assert.equal(pickCandidates(lookups, written).length, 0);
});

test('候选最多 2 条，且按查的次数排序', () => {
  const rows = [];
  for (const [id, n] of [['a', 2], ['b', 3], ['c', 2]]) {
    for (let i = 0; i < n; i += 1) rows.push(call('mcp__prts__get_stage_info', { stage_id: id }, 200 - i * 10));
  }
  const lookups = collectLookups(rows, { now: NOW });
  const picked = pickCandidates(lookups, []);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((x) => x.subject), ['b', 'a']);
  assert.equal(picked[0].text, candidateText(picked[0]));
});

test('注入块：没有候选返回空串；有候选只给事实和许可', () => {
  assert.equal(renderCandidates([]), '');
  const text = renderCandidates([
    { text: '关卡详情「main_01-07」（查过 2 次）' },
    { text: '干员信息「能天使」（查过 3 次）' },
  ]);
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(text, /还没记下来/);
  assert.match(text, /cognition_save/);
  assert.match(text, /7 天/);
});
