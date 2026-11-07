import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldInjectIntoPrompt } from '../src/domain/leaves/inori-learning-items.js';

test('学习项：私聊唤醒注入，ownlife/handoff/群聊不注入', () => {
  assert.equal(shouldInjectIntoPrompt('private:10001', 'privateMessage'), true);
  assert.equal(shouldInjectIntoPrompt('private:10001', 'probability'), true);
  assert.equal(shouldInjectIntoPrompt('private:10001', 'ownlife'), false);
  assert.equal(shouldInjectIntoPrompt('private:10001', 'handoff'), false);
  assert.equal(shouldInjectIntoPrompt('group:123456789', 'privateMessage'), false);
  assert.equal(shouldInjectIntoPrompt('', ''), false);
});
