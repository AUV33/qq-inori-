import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOpenInvitation } from '../src/domain/leaves/inori-goals.js';

const active = { id: 'g1', text: 'a', status: 'active', touchedAt: '2026-10-31T00:00:00.000Z', progress: [] };
const parked = { id: 'g2', text: 'b', status: 'parked', touchedAt: '2026-10-31T00:00:00.000Z', progress: [] };

test('目标为空时给开放邀请：想定就 goal_add，不想定就空着', () => {
  const text = renderOpenInvitation([]);
  assert.ok(text.includes('【手头没有目标】'), text);
  assert.ok(text.includes('goal_add'), text);
  assert.ok(text.includes('不想记就空着'), text);
});

test('有 active 或 parked 目标时不再重复邀请', () => {
  assert.equal(renderOpenInvitation([active]), '');
  assert.equal(renderOpenInvitation([parked]), '');
  assert.ok(renderOpenInvitation([{ ...active, status: 'done' }]).includes('【手头没有目标】'));
});
