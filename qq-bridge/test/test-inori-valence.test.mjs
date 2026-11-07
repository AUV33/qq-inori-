// inori-valence 金标：负向词表打分——最长匹配、否定检测、叠加收敛、词表缺失静默降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLexicon, appraiseText, describe, DEFAULT_LEXICON } from '../src/domain/leaves/inori-valence.js';

function lexiconFile(block) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-valence-'));
  const file = path.join(dir, 'lexicon.json');
  fs.writeFileSync(file, JSON.stringify({ _meta: { note: 'fixture' }, block }), 'utf8');
  return file;
}

test('loadLexicon：按词长降序，便于最长匹配；权重非正/空词被剔除', () => {
  const file = lexiconFile({ 难受死了: 0.9, 难受: 0.6, '': 0.5, 无所谓: 0 });
  const words = loadLexicon(file);
  assert.deepEqual(words.map((w) => w.w), ['难受死了', '难受']);
});

test('loadLexicon：文件缺失/坏 JSON 返回 null，不抛', () => {
  assert.equal(loadLexicon(path.join(os.tmpdir(), 'no-such-lexicon.json')), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-valence-bad-'));
  const bad = path.join(dir, 'x.json');
  fs.writeFileSync(bad, '不是 JSON', 'utf8');
  assert.equal(loadLexicon(bad), null);
});

test('appraiseText：词表不可用时静默给 0 分（不影响对话）', () => {
  const r = appraiseText('今天很难受', path.join(os.tmpdir(), 'missing-lexicon.json'));
  assert.deepEqual(r, { negScore: 0, hits: [], available: false });
});

test('appraiseText：命中负向词并给出权重；空文本 0 分', () => {
  const file = lexiconFile({ 难受: 0.6, 崩溃: 0.8 });
  const r = appraiseText('我有点难受', file);
  assert.equal(r.available, true);
  assert.equal(r.negScore, 0.6);
  assert.deepEqual(r.hits.map((h) => [h.w, h.weight, h.negated]), [['难受', 0.6, false]]);
  assert.equal(appraiseText('', file).negScore, 0);
});

test('appraiseText：多词叠加收敛（最强占主导，其余每个 +0.08，上限 1）', () => {
  const file = lexiconFile({ 难受: 0.5, 崩溃: 0.7, 绝望: 0.6, 想哭: 0.4 });
  const r = appraiseText('崩溃 难受 绝望 想哭', file);
  assert.equal(r.negScore, Number(Math.min(1, 0.7 + 0.08 * 3).toFixed(3)));
  assert.equal(appraiseText('崩溃 难受', file).negScore, 0.78);
  assert.equal(appraiseText('崩溃 难受 绝望 想哭', lexiconFile({ 崩溃: 0.95, 难受: 0.9, 绝望: 0.9, 想哭: 0.9 })).negScore, 1, '封顶 1');
});

test('appraiseText：否定词（不/没/别/无）让该词不贡献分数，但仍记录已否定', () => {
  const file = lexiconFile({ 高兴: 0.7, 开心: 0.6 });
  const r = appraiseText('我不高兴', file);
  assert.equal(r.negScore, 0);
  assert.deepEqual(r.hits.map((h) => [h.w, h.negated]), [['高兴', true]]);

  const none = appraiseText('我没有开心', file);
  assert.equal(none.negScore, 0);
  assert.equal(none.hits[0].negated, true);
});

test('appraiseText：最长匹配优先（「难受死了」不会被拆成「难受」）', () => {
  const file = lexiconFile({ 难受死了: 0.9, 难受: 0.5 });
  const r = appraiseText('真的难受死了', file);
  assert.deepEqual(r.hits.map((h) => h.w), ['难受死了']);
  assert.equal(r.negScore, 0.9);
});

test('describe：三种状态的人话（不可用/无命中/命中含已否定）', () => {
  assert.equal(describe(null), '词表不可用');
  assert.equal(describe({ available: false }), '词表不可用');
  assert.equal(describe({ available: true, hits: [] }), '无负向词命中');

  const file = lexiconFile({ 难受: 0.6, 高兴: 0.7 });
  const text = describe(appraiseText('难受但不高兴', file));
  assert.ok(text.includes('negScore=0.6'));
  assert.ok(text.includes('主要词=难受(0.6)'));
  assert.ok(text.includes('已否定=高兴'));
});

test('DEFAULT_LEXICON：默认取环境变量（第三方词表不入库）', () => {
  assert.equal(typeof DEFAULT_LEXICON, 'string');
});
