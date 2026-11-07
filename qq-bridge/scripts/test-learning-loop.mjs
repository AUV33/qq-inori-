// [LEARN-LOOP] 学习账本纯函数测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findConfirmedTerms, recordSlangUsage, recordSkillAttempt, summarizeLearning, renderLearningDigest,
} from '../src/domain/leaves/inori-learning-loop.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-loop-'));
  const slang = [
    { content: '草台班子', status: 'confirmed', meaning: '混乱草率的组织' },
    { content: 'woc', status: 'confirmed', meaning: '卧槽' },
    { content: '豹豹', status: 'candidate', meaning: '猎豹的萌化' },
    { content: '补刀', status: 'candidate', meaning: '' },
  ];
  const skills = { items: [
    { id: 's1', name: 'a', verify: 'file:x', injected: 10, success: 1, fail: 0 },
    { id: 's2', name: 'b', verify: '', injected: 2, success: 0, fail: 1 },
  ] };
  const paths = {
    slang: path.join(dir, 'slang.json'),
    skills: path.join(dir, 'skills.json'),
    lessonUsage: path.join(dir, 'lesson-usage.jsonl'),
    feedback: path.join(dir, 'feedback.jsonl'),
  };
  fs.writeFileSync(paths.slang, JSON.stringify(slang));
  fs.writeFileSync(paths.skills, JSON.stringify(skills));
  fs.writeFileSync(paths.lessonUsage, [
    { at: new Date().toISOString(), ids: ['l1'], outcome: 'completed' },
    { at: new Date().toISOString(), ids: ['l2'], outcome: 'aborted' },
    { at: new Date().toISOString(), ids: ['l3'], outcome: 'error' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, paths, slang };
}

test('findConfirmedTerms 只认已确认且长度≥2的词', () => {
  const { slang } = fixture();
  assert.deepEqual(findConfirmedTerms('今天这草台班子真行，woc', slang), ['草台班子', 'woc']);
  assert.deepEqual(findConfirmedTerms('豹豹来了', slang), []);
});

test('recordSlangUsage 同一天同词只记一次', () => {
  const { paths, slang } = fixture();
  const now = Date.now();
  assert.equal(recordSlangUsage(slang, 'private:1', '草台班子', now, paths.feedback), 1);
  assert.equal(recordSlangUsage(slang, 'private:1', '草台班子又来了', now + 1000, paths.feedback), 0);
  assert.equal(recordSlangUsage(slang, 'private:2', 'woc 草台班子', now + 2000, paths.feedback), 1);
  const rows = fs.readFileSync(paths.feedback, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'slang_used');
});

test('recordSkillAttempt 记录技能回合结果', () => {
  const { paths } = fixture();
  assert.equal(recordSkillAttempt(['s1', 's2'], 'completed', 'private:1', Date.now(), paths.feedback), 2);
  const rows = fs.readFileSync(paths.feedback, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].type, 'skill_attempt');
  assert.deepEqual(rows[0].ids, ['s1', 's2']);
});

test('summarizeLearning 汇总黑话/经验/技能且不编数', () => {
  const { paths, slang } = fixture();
  recordSlangUsage(slang, 'private:1', '草台班子', Date.now(), paths.feedback);
  recordSkillAttempt(['s1'], 'completed', 'private:1', Date.now(), paths.feedback);
  const stats = summarizeLearning(7, Date.now(), paths);
  assert.equal(stats.slang.total, 4);
  assert.equal(stats.slang.confirmed, 2);
  assert.equal(stats.slang.candidates, 2);
  assert.equal(stats.slang.pendingWithMeaning, 1);
  assert.equal(stats.slang.usedTerms, 1);
  assert.equal(stats.lessons.outcomes.completed, 1);
  assert.equal(stats.lessons.outcomes.aborted, 1);
  assert.equal(stats.lessons.outcomes.error, 1);
  assert.equal(stats.skills.total, 2);
  assert.equal(stats.skills.withVerify, 1);
  assert.equal(stats.skills.attempts, 0);
  assert.equal(stats.skills.windowAttempts, 1);
  assert.equal(stats.skills.completed, 1);
});

test('renderLearningDigest 输出事实与许可，不出现命令句', () => {
  const { paths, slang } = fixture();
  recordSlangUsage(slang, 'private:1', '草台班子', Date.now(), paths.feedback);
  const text = renderLearningDigest(summarizeLearning(7, Date.now(), paths));
  assert.match(text, /学习账本/);
  assert.match(text, /已确认 2/);
  assert.match(text, /跑完 1/);
  assert.match(text, /你定/);
  assert.doesNotMatch(text, /必须|立刻|马上/);
});
