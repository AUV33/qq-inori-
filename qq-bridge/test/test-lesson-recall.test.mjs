// test-lesson-recall.test.mjs · 宪章 §5.10/G13：教训库必须进入检索域，且候选不污染注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-recall-'));
process.env.QQ_INORI_ROOT = ROOT;

const {
  rankLessons, renderLessonsRecallBlock, loadLessonsForRecall, lessonCoverage,
} = await import('../src/domain/memory/lesson-recall.mjs');
const { createLessonsLedger, buildCandidate, buildVerdict } = await import('../src/domain/mind/lessons-ledger.mjs');

const T = Date.UTC(2026, 10, 5, 12);
const lesson = (over) => ({
  id: 'ls_20261105_aaaaaa', rule: '查 ws 重连先看端口再改代码', status: 'verified', confidence: 0.85,
  pos: 2, neg: 0, updatedAt: T, rule2: undefined, ...over,
});

test('排序：相关度优先；candidate/demoted/expired 不注入', () => {
  const list = [
    lesson({ id: 'ls_20261105_aaaaaa', rule: '查 ws 重连先看端口再改代码', status: 'verified' }),
    lesson({ id: 'ls_20261105_bbbbbb', rule: '别熬夜查资料', status: 'active', confidence: 0.6 }),
    lesson({ id: 'ls_20261105_cccccc', rule: 'ws 重连的另一个候选', status: 'candidate' }),
    lesson({ id: 'ls_20261105_dddddd', rule: 'ws 重连已被证伪', status: 'demoted' }),
    lesson({ id: 'ls_20261105_eeeeee', rule: 'ws 重连过期了', status: 'expired' }),
  ];
  const ranked = rankLessons(list, 'ws 重连 端口', { topK: 4 });
  assert.equal(ranked.length, 1, '只有 verified 命中');
  assert.equal(ranked[0].id, 'ls_20261105_aaaaaa');
  assert.ok(lessonCoverage('ws 重连', '查 ws 重连先看端口') > 0);

  const noQuery = rankLessons([lesson({ status: 'active', confidence: 0.9 }), lesson({ id: 'ls_20261105_ffffff', rule: '低置信', status: 'verified', confidence: 0.5 })], '', { topK: 2 });
  assert.equal(noQuery.length, 2, '无 query 时取已验证/生效的高置信');
  assert.equal(noQuery[0].status, 'verified', '状态权重优先于单条置信');
});

test('渲染：空为空串；有条目带块头与状态标记，不写成命令', () => {
  assert.equal(renderLessonsRecallBlock([]), '');
  const text = renderLessonsRecallBlock([lesson(), lesson({ id: 'ls_20261105_bbbbbb', status: 'active', rule: '别熬夜' })]);
  assert.match(text, /这也许和此刻有关/);
  assert.match(text, /✅ 查 ws 重连/);
  assert.match(text, /· 别熬夜/);
  assert.equal(/你应该|必须/.test(text), false);
});

test('只读加载：折叠后只留可注入状态；TTL 过期不注入；坏文件返回空', async () => {
  const file = path.join(ROOT, 'data', 'state', 'mind', 'lessons-ledger.jsonl');
  const store = createLessonsLedger({ file, now: () => T });
  const c = buildCandidate({ rule: '查 ws 重连先看端口', evidenceIds: ['ev1'], at: T });
  await store.appendEvent(c, { writer: 'capture' });
  await store.appendEvent(buildVerdict(c.id, 'pos', { at: T + 1 }), { writer: 'verify' });
  await store.appendEvent(buildVerdict(c.id, 'pos', { at: T + 2 }), { writer: 'verify' });

  const lessons = loadLessonsForRecall({ file, now: T + 2 });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].status, 'verified');
  assert.equal(loadLessonsForRecall({ file, now: T + 365 * 86400000 }).filter((l) => l.status === 'verified').length, 0, 'TTL 过后不再 verified');
  assert.deepEqual(loadLessonsForRecall({ file: path.join(ROOT, 'nope.jsonl') }), []);
});

test('接线：memory-retrieve 真的加载教训账并渲染到 recallBlock', async () => {
  const file = path.join(ROOT, 'data', 'state', 'mind', 'lessons-ledger.jsonl');
  const lessons = loadLessonsForRecall({ file, now: T + 2 });
  assert.ok(lessons.length >= 1, '前置：上一条用例已写入 verified 教训');

  const mem = await import('../src/domain/memory/memory-retrieve.js');
  const block = await mem.recallBlock('ws 重连原理', { scope: 'private' });
  assert.match(block.text, /这也许和此刻有关/);
  assert.match(block.text, /查 ws 重连先看端口/);
});
