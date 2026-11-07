// [SELF-EDIT-VERIFY] 她改自己代码的判定规则——回归锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRelPath, isAllowedCodePath, isEntryFile, testPathFor,
  planChecks, classifyChecks, diffStat,
} from '../src/domain/persona/self-edit-verify.mjs';

test('路径规范化：反斜杠/./ 都归一，.. 与绝对路径判空', () => {
  assert.equal(normalizeRelPath('qq-bridge\\src\\a.mjs'), 'qq-bridge/src/a.mjs');
  assert.equal(normalizeRelPath('./qq-bridge/src/a.mjs'), 'qq-bridge/src/a.mjs');
  assert.equal(normalizeRelPath('../etc/passwd'), '');
  assert.equal(normalizeRelPath('C:/x/a.js'), '');
  assert.equal(normalizeRelPath('/abs/a.js'), '');
});

test('只允许 src 下的代码；脚本/测试/数据/护栏自己都不许改', () => {
  assert.equal(isAllowedCodePath('qq-bridge/src/speak-gate.mjs'), true);
  assert.equal(isAllowedCodePath('qq-bridge/src/inori-lessons.js'), true);
  assert.equal(isAllowedCodePath('ai-companion-kit/packages/memory-mcp/src/memory-mcp.js'), true);

  assert.equal(isAllowedCodePath('qq-bridge/scripts/self-edit-guard.mjs'), false);
  assert.equal(isAllowedCodePath('qq-bridge/scripts/plan.mjs'), false);
  assert.equal(isAllowedCodePath('qq-bridge/test/x.test.mjs'), false);
  assert.equal(isAllowedCodePath('data/state/social-v2.json'), false);
  assert.equal(isAllowedCodePath('qq-bridge/src/../scripts/plan.mjs'), false);
  assert.equal(isAllowedCodePath('qq-bridge/src/readme.md'), false);
});

test('入口文件识别 + 同名测试路径', () => {
  assert.equal(isEntryFile('qq-bridge/src/app.mjs'), true);
  assert.equal(isEntryFile('qq-bridge/src/bridge.js'), true);
  assert.equal(isEntryFile('qq-bridge/src/other.mjs'), false);
  assert.equal(testPathFor('qq-bridge/src/speak-gate.mjs'), 'qq-bridge/test/test-speak-gate.test.mjs');
});

test('检查计划：语法必跑，入口加冒烟，有测试加测试', () => {
  assert.deepEqual(planChecks({ rel: 'qq-bridge/src/speak-gate.mjs' }).map((c) => c.kind), ['syntax']);
  assert.deepEqual(planChecks({ rel: 'qq-bridge/src/speak-gate.mjs', hasTest: true }).map((c) => c.kind), ['syntax', 'test']);
  assert.deepEqual(planChecks({ rel: 'qq-bridge/src/app.mjs' }).map((c) => c.kind), ['syntax', 'smoke']);
  assert.deepEqual(planChecks({ rel: 'qq-bridge/scripts/plan.mjs' }), []);
});

test('分数：全过才 passed，任一失败即 failed', () => {
  assert.equal(classifyChecks([{ kind: 'syntax', ok: true }]).score, 'passed');
  assert.equal(classifyChecks([{ kind: 'syntax', ok: true }, { kind: 'test', ok: false, detail: 'x' }]).score, 'failed');
  assert.equal(classifyChecks([{ kind: 'syntax', ok: true }, { kind: 'test', ok: false }]).failed[0].kind, 'test');
  assert.equal(classifyChecks([]).score, 'failed'); // 什么都没跑 ≠ 通过
});

test('改动摘要', () => {
  const d = diffStat('a\nb', 'a\nb\nc');
  assert.equal(d.lineDelta, 1);
  assert.equal(d.changed, true);
  assert.equal(diffStat('same', 'same').changed, false);
});
