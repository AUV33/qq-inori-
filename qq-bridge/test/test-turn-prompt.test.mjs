import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitTurnPrompt } from '../src/domain/conversation/turn-prompt.js';

function fixture(result) {
  const calls = { acquire: 0, bind: 0, release: 0, prompt: 0 };
  const grant = { id: 'g1' };
  return {
    calls,
    grant,
    args: {
      sessionId: 'session-1',
      label: 'private:1',
      kind: 'chat',
      content: [{ type: 'text', text: 'hello' }],
      acquireTurnSlot: async () => { calls.acquire += 1; return grant; },
      bindTurnGrant: (value, sessionId) => { calls.bind += 1; return value === grant && sessionId === 'session-1'; },
      releaseTurnGrant: (value) => { if (value) calls.release += 1; return true; },
      prompt: async () => { calls.prompt += 1; return result; },
    },
  };
}

test('正常模型回合保留 grant，交给 turn/start 消费', async () => {
  const f = fixture({ result: { ok: true, value: {} } });
  await submitTurnPrompt(f.args);
  assert.deepEqual(f.calls, { acquire: 1, bind: 1, release: 0, prompt: 1 });
});

test('DSH 拒绝 prompt 时立即释放 grant', async () => {
  const f = fixture({ result: { ok: false, error: { code: 'busy' } } });
  await submitTurnPrompt(f.args);
  assert.equal(f.calls.release, 1);
});

test('直接命令没有 turn/start，立即释放 grant', async () => {
  const f = fixture({ result: { ok: true, value: { command: { text: 'done' } } } });
  await submitTurnPrompt(f.args);
  assert.equal(f.calls.release, 1);
});

test('提交异常时释放 grant 并保留原异常', async () => {
  const f = fixture(null);
  const expected = new Error('transport failed');
  f.args.prompt = async () => { f.calls.prompt += 1; throw expected; };
  await assert.rejects(() => submitTurnPrompt(f.args), expected);
  assert.equal(f.calls.release, 1);
});

test('已有活跃回合时可不申请新槽位，直接交给 DSH 队列', async () => {
  const f = fixture({ result: { ok: true, value: {} } });
  await submitTurnPrompt({ ...f.args, useSlot: false });
  assert.deepEqual(f.calls, { acquire: 0, bind: 0, release: 0, prompt: 1 });
});
