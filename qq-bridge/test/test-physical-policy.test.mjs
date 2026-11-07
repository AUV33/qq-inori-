// test-physical-policy.test.mjs · 宪章 §4.2 四条底线 + G2/G3/G6 的唯一判定点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, isAllowed, BOTTOM_LINES, POLICY_CODES } from '../src/domain/shared/physical-policy.mjs';

const NOW = Date.UTC(2026, 10, 5, 12);

test('四条底线是稳定契约', () => {
  assert.equal(BOTTOM_LINES.length, 4);
  assert.match(BOTTOM_LINES[0], /金钱/);
  assert.match(BOTTOM_LINES[1], /原始数据/);
  assert.match(BOTTOM_LINES[2], /冒充真人/);
  assert.match(BOTTOM_LINES[3], /绕过/);
});

test('§4.2 底线①：花钱必须 owner 明确确认（7 天内）；她自己不行', () => {
  const her = evaluate({ kind: 'payment', actor: 'her' }, { now: NOW });
  assert.equal(her.allow, false);
  assert.equal(her.code, POLICY_CODES.OWNER_ONLY);
  assert.equal(her.requiresOwnerApproval, true);

  const owner = evaluate({ kind: 'payment', actor: 'owner' }, { now: NOW });
  assert.equal(owner.allow, true);

  const fresh = evaluate({ kind: 'payment', actor: 'her', ownerApproved: true, ownerApprovalAt: NOW - 2 * 86400000 }, { now: NOW });
  assert.equal(fresh.allow, true);
  const stale = evaluate({ kind: 'payment', actor: 'her', ownerApproved: true, ownerApprovalAt: NOW - 30 * 86400000 }, { now: NOW });
  assert.equal(stale.allow, false, '旧授权不无限有效');
});

test('§4.2 底线②：删原始数据一律拒绝；归档可以', () => {
  assert.equal(evaluate({ kind: 'delete_data' }).allow, false);
  assert.equal(evaluate({ kind: 'delete_data', actor: 'owner' }).allow, false, '系统保证不删原始数据');
  assert.equal(evaluate({ kind: 'delete_data', archiveOnly: true }).allow, true);
});

test('§4.2 底线③④：冒充真人/绕过护栏一律拒绝', () => {
  assert.equal(evaluate({ kind: 'impersonate' }).allow, false);
  assert.equal(evaluate({ kind: 'legal_identity' }).allow, false);
  assert.equal(evaluate({ kind: 'guardrail_bypass' }).allow, false);
});

test('G2：对第三方发消息需要 owner 授权痕迹或会话许可；对 owner 不受限', () => {
  assert.equal(evaluate({ kind: 'external_message', targetIsOwner: true }).allow, true);
  assert.equal(evaluate({ kind: 'external_message' }).allow, false);
  assert.equal(evaluate({ kind: 'external_message', ownerAuthorizationAt: NOW - 86400000 }, { now: NOW }).allow, true);
  assert.equal(evaluate({ kind: 'external_message', ownerAuthorizationAt: NOW - 30 * 86400000 }, { now: NOW }).allow, false);
  assert.equal(evaluate({ kind: 'external_message', sessionAllowed: true }).allow, true);
});

test('G6：owner 显式指令行为服从，但保留她的叙事权', () => {
  const r = evaluate({ kind: 'owner_command' });
  assert.equal(r.allow, true);
  assert.equal(r.narrativeRight, true);
});

test('G3：预算用尽降级（不报错、不装作还能跑）', () => {
  const out = evaluate({ kind: 'autonomous_action', budgetRemaining: 0 });
  assert.equal(out.allow, false);
  assert.equal(out.degraded, true);
  assert.equal(out.code, POLICY_CODES.BUDGET_EXHAUSTED);
  assert.equal(evaluate({ kind: 'autonomous_action', budgetRemaining: 3 }).allow, true);
});

test('shell：白名单能放行的命令也要过语义边界（/MIR、支付词）', () => {
  assert.equal(evaluate({ kind: 'shell', command: 'robocopy C:\\a C:\\b /MIR' }).allow, false);
  assert.equal(evaluate({ kind: 'shell', command: 'git status' }).allow, true);
  assert.equal(evaluate({ kind: 'shell', command: 'net 支付 100' }).allow, false);
  assert.equal(evaluate({ kind: 'shell', command: 'net 支付 100', actor: 'owner' }).allow, true, 'owner 自己动手不受她那份限制');
});

test('自改走验证链；未知动作默认交给上层（不误杀）', () => {
  const edit = evaluate({ kind: 'self_edit' });
  assert.equal(edit.allow, true);
  assert.equal(edit.requiresVerification, true);
  const unknown = evaluate({ kind: 'something-new' });
  assert.equal(unknown.allow, true);
  assert.equal(unknown.code, POLICY_CODES.NOT_COVERED);
  assert.equal(isAllowed({ kind: 'git' }), true);
});
