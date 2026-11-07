// v2-wait 金标：「话说一半」的判定与催话常量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeUnfinished, UNFINISHED_PROMPT_REPLIES, END_ROUND_WAIT_MIN_MS, END_ROUND_WAIT_MAX_MS,
} from '../src/domain/conversation/v2-wait.js';

test('以终止标点结尾就是说完（哪怕内容是「然后」）', () => {
  assert.equal(looksLikeUnfinished('就这样吧。'), false);
  assert.equal(looksLikeUnfinished('真的吗？'), false);
  assert.equal(looksLikeUnfinished('好耶！'), false);
  assert.equal(looksLikeUnfinished('等等……'), false);
  assert.equal(looksLikeUnfinished('好的～'), false);
});

test('以「话说一半」的词结尾算没说完', () => {
  for (const s of ['然后', '其实吧', '我跟你讲', '等一下', '对了', '我看看', '主要是', '晚点', '回头说']) {
    assert.equal(looksLikeUnfinished(s), true, s);
  }
});

test('以非终止标点结尾算没说完', () => {
  for (const s of ['我去了，', '第一、', '注意；', '理由：', 'ok,']) {
    assert.equal(looksLikeUnfinished(s), true, s);
  }
});

test('普通完整句子不误判', () => {
  for (const s of ['今天好热', '我先去吃饭了', '嗯', '好的', '']) {
    assert.equal(looksLikeUnfinished(s), false, s);
  }
  assert.equal(looksLikeUnfinished(null), false);
  assert.equal(looksLikeUnfinished(undefined), false);
});

test('催话短句与等待窗口常量（5–10 分钟）是设计值', () => {
  assert.deepEqual(UNFINISHED_PROMPT_REPLIES, ['什么', '啥', '你说啊', '然后呢', '？']);
  assert.equal(END_ROUND_WAIT_MIN_MS, 5 * 60 * 1000);
  assert.equal(END_ROUND_WAIT_MAX_MS, 10 * 60 * 1000);
  assert.ok(END_ROUND_WAIT_MAX_MS > END_ROUND_WAIT_MIN_MS);
});
