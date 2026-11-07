// inori-learning-loop 金标：学习账本——词有没有被用、经验跑完没、技能结果，都是可机检的事实。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findConfirmedTerms, recordSlangUsage, recordSkillAttempt, recordLessonUsage, summarizeLearning, renderLearningDigest,
} from '../src/domain/leaves/inori-learning-loop.js';

const NOW = new Date('2026-11-02T12:00:00Z').getTime();
const DAY = 86400000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-learn-'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v), 'utf8'); };
const writeJsonl = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'); };

test('findConfirmedTerms：只认 confirmed 且长度≥2 的词', () => {
  const entries = [
    { content: '绷不住', status: 'confirmed' },
    { content: 'yyds', status: 'confirmed' },
    { content: '一', status: 'confirmed' },
    { content: '候选词', status: 'candidate' },
  ];
  assert.deepEqual(findConfirmedTerms('我绷不住了 yyds', entries), ['绷不住', 'yyds']);
  assert.deepEqual(findConfirmedTerms('', entries), []);
  assert.deepEqual(findConfirmedTerms('随便说说', null), []);
});

test('recordLessonUsage + summarizeLearning：经验效果闭环可度量（F4 学习闭环闭合）', () => {
  const usageFile = path.join(tmp(), 'lesson-usage.jsonl');
  assert.equal(recordLessonUsage([], 'completed', 'group:1', NOW, usageFile), 0, '无 id 不写');
  recordLessonUsage(['l1', 'l2'], 'completed', 'group:1', NOW, usageFile);
  recordLessonUsage(['l3'], 'aborted', 'group:1', NOW - DAY, usageFile);
  recordLessonUsage(['l4'], 'error', 'group:1', NOW - 10 * DAY, usageFile); // 超出 7 天窗口，不计入
  const s = summarizeLearning(7, NOW, { lessonUsage: usageFile });
  assert.equal(s.lessons.total, 2, '仅窗口内的 2 次计入');
  assert.equal(s.lessons.outcomes.completed, 1);
  assert.equal(s.lessons.outcomes.aborted, 1);
  assert.equal(s.lessons.outcomes.error, 0);
  assert.ok(Math.abs(s.lessons.completedRate - 0.5) < 1e-9, 'completedRate=0.5');
});

test('recordLessonUsage：写入字段形状与 mux-bus 生产路径一致（可统一度量）', () => {
  const usageFile = path.join(tmp(), 'lesson-usage.jsonl');
  recordLessonUsage(['l9'], 'completed', 'private:2', NOW, usageFile);
  const rows = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'ids', 'key', 'outcome']);
  assert.deepEqual(rows[0].ids, ['l9']);
  assert.equal(rows[0].key, 'private:2');
  assert.equal(rows[0].outcome, 'completed');
});

test('recordSlangUsage：同词同一天只记一次（连发多条不刷屏）', () => {
  const dir = tmp();
  const file = path.join(dir, 'feedback.jsonl');
  const entries = [{ content: '绷不住', status: 'confirmed' }];
  const day = new Date(NOW);
  assert.equal(recordSlangUsage(entries, 'group:1', '绷不住了', day.getTime(), file), 1);
  assert.equal(recordSlangUsage(entries, 'group:1', '又绷不住了', day.getTime() + 1000, file), 0, '同词同天去重');
  assert.equal(recordSlangUsage(entries, 'group:1', '绷不住了', day.getTime() + DAY, file), 1, '换一天可以再记');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.type), ['slang_used', 'slang_used']);
});

test('recordSlangUsage：没命中任何已确认词返回 0 且不写盘', () => {
  const dir = tmp();
  const file = path.join(dir, 'f.jsonl');
  assert.equal(recordSlangUsage([], 'k', '普通的话', NOW, file), 0);
  assert.equal(fs.existsSync(file), false);
});

test('recordSkillAttempt：按 ids 条数返回，outcome 落盘', () => {
  const dir = tmp();
  const file = path.join(dir, 'f.jsonl');
  assert.equal(recordSkillAttempt(['a', 'b'], 'completed', 'group:1', NOW, file), 2);
  assert.equal(recordSkillAttempt([], 'completed', 'k', NOW, file), 0);
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(row.type, 'skill_attempt');
  assert.equal(row.outcome, 'completed');
  assert.deepEqual(row.ids, ['a', 'b']);
});

test('summarizeLearning：黑话总数/已确认/待判/有释义', () => {
  const dir = tmp();
  const paths = {
    slang: path.join(dir, 'slang.json'),
    skills: path.join(dir, 'skills.json'),
    lessonUsage: path.join(dir, 'usage.jsonl'),
    feedback: path.join(dir, 'feedback.jsonl'),
  };
  writeJson(paths.slang, [
    { content: '甲', status: 'confirmed' },
    { content: '乙', status: 'candidate', meaning: '有释义' },
    { content: '丙', status: 'candidate' },
  ]);
  const s = summarizeLearning(7, NOW, paths);
  assert.deepEqual(s.slang, { total: 3, confirmed: 1, candidates: 2, pendingWithMeaning: 1, usedTerms: 0, usedSample: [] });
});

test('summarizeLearning：窗口内的用词与经验结局分开统计', () => {
  const dir = tmp();
  const paths = {
    slang: path.join(dir, 'slang.json'),
    skills: path.join(dir, 'skills.json'),
    lessonUsage: path.join(dir, 'usage.jsonl'),
    feedback: path.join(dir, 'feedback.jsonl'),
  };
  writeJson(paths.slang, []);
  writeJsonl(paths.feedback, [
    { at: at(1), type: 'slang_used', term: '绷不住' },
    { at: at(1), type: 'slang_used', term: '绷不住' },
    { at: at(2), type: 'slang_used', term: 'yyds' },
    { at: at(30), type: 'slang_used', term: '窗口外' },
    { at: at(1), type: 'skill_attempt', outcome: 'completed' },
    { at: at(1), type: 'skill_attempt', outcome: 'error' },
  ]);
  writeJsonl(paths.lessonUsage, [
    { at: at(1), outcome: 'completed' },
    { at: at(2), outcome: 'aborted' },
    { at: at(3), outcome: 'error' },
    { at: at(4), outcome: 'weird' },
    { at: at(30), outcome: 'completed' },
  ]);
  const s = summarizeLearning(7, NOW, paths);
  assert.equal(s.slang.usedTerms, 2, '去重后的词数');
  assert.deepEqual(s.slang.usedSample.sort(), ['yyds', '绷不住'].sort());
  assert.deepEqual(s.lessons.outcomes, { completed: 1, aborted: 1, error: 1, other: 1 });
  assert.equal(s.lessons.total, 4);
  assert.equal(s.lessons.completedRate, 0.25);
  assert.equal(s.skills.windowAttempts, 2);
  assert.equal(s.skills.completed, 1);
});

test('summarizeLearning：技能库累计字段（注入/成功/失败/有验证/尝试/降级）', () => {
  const dir = tmp();
  const paths = {
    slang: path.join(dir, 'slang.json'), skills: path.join(dir, 'skills.json'),
    lessonUsage: path.join(dir, 'u.jsonl'), feedback: path.join(dir, 'f.jsonl'),
  };
  writeJson(paths.skills, { items: [
    { injected: 3, success: 2, fail: 1, attempts: 3, verify: '文件:x', degraded: false },
    { injected: 1, success: 0, fail: 2, attempts: 2, degraded: true },
  ] });
  const s = summarizeLearning(7, NOW, paths);
  assert.deepEqual(s.skills, {
    total: 2, injected: 4, success: 2, fail: 3, withVerify: 1, attempts: 5, degraded: 1,
    windowAttempts: 0, completed: 0,
  });
});

test('summarizeLearning：文件全缺失时返回零值（不炸）', () => {
  const s = summarizeLearning(7, NOW, { slang: '/nope/a.json', skills: '/nope/b.json', lessonUsage: '/nope/c.jsonl', feedback: '/nope/d.jsonl' });
  assert.equal(s.slang.total, 0);
  assert.equal(s.lessons.total, 0);
  assert.equal(s.skills.total, 0);
});

test('renderLearningDigest：带账本数字与「你定」的许可', () => {
  const text = renderLearningDigest({
    days: 7,
    slang: { total: 5, confirmed: 2, candidates: 3, pendingWithMeaning: 1, usedTerms: 1, usedSample: ['绷不住'] },
    lessons: { total: 4, outcomes: { completed: 2, aborted: 1, error: 1 }, completedRate: 0.5 },
    skills: { total: 3, injected: 4, success: 2, fail: 1, withVerify: 1, attempts: 5, degraded: 0, windowAttempts: 3, completed: 2 },
  });
  assert.ok(text.startsWith('【学习账本·最近7天】'));
  assert.ok(text.includes('黑话：共 5 条（已确认 2 / 待判 3，其中有释义 1）'));
  assert.ok(text.includes('最近说过的已确认词 1 个（绷不住）'));
  assert.ok(text.includes('经验：注入 4 次，回合正常收尾 2（50%）'));
  assert.ok(text.includes('技能：3 条'));
  assert.ok(text.includes('你定'), '只给许可，不命令');
});
