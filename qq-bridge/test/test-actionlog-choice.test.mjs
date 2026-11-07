import test from 'node:test';
import assert from 'node:assert/strict';
import { inferChosenBy } from '../src/domain/leaves/inori-actionlog.js';

test('chosenBy：她自己的时间归她，主人动作归 owner，其余归系统', () => {
  assert.equal(inferChosenBy({ trigger: 'own-life' }), 'her');
  assert.equal(inferChosenBy({ trigger: 'free-tick' }), 'her');
  assert.equal(inferChosenBy({ trigger: 'boredom' }), 'her');
  assert.equal(inferChosenBy({ by: 'her' }), 'her');
  assert.equal(inferChosenBy({ by: 'console' }), 'owner');
  assert.equal(inferChosenBy({ trigger: 'proactiveCheck' }), 'system');
  assert.equal(inferChosenBy({ chosenBy: 'owner' }), 'owner');
});
