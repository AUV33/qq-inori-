// [DSH-ENVELOPE] unwrap 的契约：成功取值、失败按 label 抛出、不吞错误码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrap } from '../src/domain/leaves/dsh-envelope.mjs';

test('成功信封：直接返回值', () => {
  assert.deepEqual(unwrap({ result: { ok: true, value: { sessionId: 's1' } } }, 'spawn'), { sessionId: 's1' });
  assert.equal(unwrap({ result: { ok: true, value: 0 } }, 'x'), 0);
});

test('失败信封：抛错并带 label + code + message', () => {
  assert.throws(
    () => unwrap({ result: { ok: false, error: { code: 'E_BAD', message: 'nope' } } }, 'spawn'),
    /spawn failed: E_BAD: nope/,
  );
});
