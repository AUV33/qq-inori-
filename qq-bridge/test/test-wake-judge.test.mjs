import assert from 'node:assert/strict';
import test from 'node:test';
import { mapJudgeToWake, classifyWakeIntent, _clearWakeJudgeCache } from '../src/domain/conversation/wake-judge.mjs';

test('mapJudgeToWake：target=你 → 关于她', () => {
  assert.deepEqual(mapJudgeToWake({ target: '你', confidence: 0.82 }), {
    aboutHer: true, target: '你', confidence: 0.82, available: true,
  });
});

test('mapJudgeToWake：target=别人/自己/无 → 不关于她', () => {
  assert.equal(mapJudgeToWake({ target: '别人', confidence: 0.9 }).aboutHer, false);
  assert.equal(mapJudgeToWake({ target: '自己', confidence: 0.9 }).aboutHer, false);
  assert.equal(mapJudgeToWake({ target: '无', confidence: 0.9 }).aboutHer, false);
});

test('mapJudgeToWake：空/异常输入 → null', () => {
  assert.equal(mapJudgeToWake(null), null);
  assert.equal(mapJudgeToWake(undefined), null);
  assert.equal(mapJudgeToWake('nope'), null);
  assert.equal(mapJudgeToWake({ target: '你' }), null); // 缺 confidence
  assert.equal(mapJudgeToWake({ target: '你', confidence: NaN }), null);
  assert.equal(mapJudgeToWake({ target: '你', confidence: 'high' }), null);
});

test('classifyWakeIntent：judgeWake=false → 直接 null（回退概率）', async () => {
  _clearWakeJudgeCache();
  const r = await classifyWakeIntent('你觉得这个怎么样', { cfg: { floor: { judgeWake: false } } });
  assert.equal(r, null);
});

test('classifyWakeIntent：文本过短 → null', async () => {
  _clearWakeJudgeCache();
  const r = await classifyWakeIntent('a', { cfg: { floor: { judgeWake: true } } });
  assert.equal(r, null);
});

test('classifyWakeIntent：未传 cfg → 默认启用但会因本地3B不可用抛错回退 null', async () => {
  _clearWakeJudgeCache();
  // local3bBase(undefined) 会构造出非法 baseUrl，judgeByModel 内部 fetch 失败/超时 → 捕获返回 null
  const r = await classifyWakeIntent('你怎么看这件事', { cfg: {} });
  assert.equal(r, null);
});
