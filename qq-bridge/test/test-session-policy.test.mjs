// session-policy 金标：preset 解析必须 fail-closed，群聊绝不能回退到带本地工具的默认 preset。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionPolicy } from '../src/domain/conversation/session-policy.mjs';

function makeCtx(overrides = {}) {
  const cfg = {
    ownerQQ: 10001,
    agentPreset: 'qq-chat',
    socialV2: { agentPreset: 'qq-chat-v2' },
    ...(overrides.cfg ?? {}),
  };
  const state = { sessions: {}, sessionPolicies: {}, ...(overrides.state ?? {}) };
  const logs = [];
  const convStates = new Map(Object.entries(overrides.convStates ?? {}));
  const svc = createSessionPolicy({
    getCfg: () => cfg,
    getCurrentMode: () => overrides.mode ?? 'reserved2',
    getDshPresetIds: () => overrides.presetIds ?? ['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-admin', 'qq-mode'],
    getDshDefaultPreset: () => overrides.defaultPreset ?? 'standard',
    getClosedAgentPreset: () => overrides.closedPreset ?? 'qq-chat',
    allowed: (kind, id, c) => overrides.allowedImpl ? overrides.allowedImpl(kind, id, c) : (kind === 'group' ? String(id) === '123456789' : String(id) === String(c.ownerQQ)),
    getSocialV2State: (key) => {
      if (!convStates.has(key)) convStates.set(key, { unread: [] });
      return convStates.get(key);
    },
    state,
    log: (m) => logs.push(String(m)),
  });
  return { svc, cfg, state, logs, convStates };
}

test('resolvePresetName：strict 遇到未知名字返回空串，绝不回退默认 preset', () => {
  const h = makeCtx();
  assert.equal(h.svc.resolvePresetName('qq-chat-v2', { strict: true }), 'qq-chat-v2');
  assert.equal(h.svc.resolvePresetName('不存在', { strict: true }), '');
  assert.ok(h.logs.some((l) => l.includes('拒绝回退到 DSH 默认 preset')));
});

test('resolvePresetName：非 strict（closed-agent）才允许回退到 DSH 默认 preset', () => {
  const h = makeCtx();
  assert.equal(h.svc.resolvePresetName('不存在', { strict: false }), 'standard');
  assert.equal(h.svc.resolvePresetName('', { strict: true }), '', '空名 strict 也是空');
  assert.equal(h.svc.resolvePresetName('', { strict: false }), 'standard');
});

test('resolvePresetName：DSH 清单未知时 strict 一律 fail-closed', () => {
  const h = makeCtx({ presetIds: [] });
  assert.equal(h.svc.resolvePresetName('qq-chat-v2', { strict: true }), '');
  assert.equal(h.svc.resolvePresetName('qq-chat-v2', { strict: false }), 'qq-chat-v2');
});

test('modePreset：群聊永远拿不到 qq-chat-admin（哪怕它在清单里）', () => {
  const h = makeCtx();
  const got = h.svc.modePreset('group:123456789', 'reserved2', h.cfg);
  assert.equal(got, 'qq-chat-v2');
  assert.notEqual(got, 'qq-chat-admin');
});

test('modePreset：owner 私聊在 reserved2 用 qq-chat-admin；没有 admin 时退回聊天 preset', () => {
  const h = makeCtx();
  assert.equal(h.svc.modePreset('private:10001', 'reserved2', h.cfg), 'qq-chat-admin');
  const noAdmin = makeCtx({ presetIds: ['standard', 'qq-chat', 'qq-chat-v2'] });
  assert.equal(noAdmin.svc.modePreset('private:10001', 'reserved2', noAdmin.cfg), 'qq-chat-v2');
  assert.ok(noAdmin.logs.some((l) => l.includes('qq-chat-admin 不在 DSH preset 清单里')));
});

test('modePreset：closed-agent 用 closedAgentPreset，未知时按 DSH 默认 preset 建会话', () => {
  const h = makeCtx({ closedPreset: 'qq-chat' });
  assert.equal(h.svc.modePreset('private:10001', 'closed-agent', h.cfg), 'qq-chat');
  const unknown = makeCtx({ closedPreset: 'nope' });
  assert.equal(unknown.svc.modePreset('private:10001', 'closed-agent', unknown.cfg), 'standard',
    'closed-agent 仅 owner 私聊，未知 preset 回退 DSH 默认（不构成提权），并留日志');
  assert.ok(unknown.logs.some((l) => l.includes('不在 DSH 可用清单')), '要留下 preset 不可用的日志');
});

test('modeAllowed：closed-agent 只放行 owner 私聊', () => {
  const h = makeCtx();
  assert.equal(h.svc.modeAllowed('private:10001', 'private', 10001, h.cfg, 'closed-agent'), true);
  assert.equal(h.svc.modeAllowed('group:123456789', 'group', 123456789, h.cfg, 'closed-agent'), false);
  assert.equal(h.svc.modeAllowed('private:1', 'private', 1, h.cfg, 'closed-agent'), false);
});

test('lane key：只在结尾 #owner 时算 owner 车道', () => {
  const h = makeCtx();
  assert.equal(h.svc.laneBaseKey('group:123456789#owner'), 'group:123456789');
  assert.equal(h.svc.laneBaseKey('group:123456789'), 'group:123456789');
  assert.equal(h.svc.laneBaseKey('group:1#owner#owner'), 'group:1#owner');
  assert.equal(h.svc.isOwnerLaneKey('group:1#owner'), true);
  assert.equal(h.svc.isOwnerLaneKey('group:1'), false);
});

test('ownerLaneFor：最后一条未读是 owner 才算', () => {
  const ownerMsg = { seq: 9, isOwner: true, isSelf: false };
  const other = { seq: 10, isOwner: false, isSelf: false };
  const on = makeCtx({ convStates: { 'group:123456789': { unread: [ownerMsg] } } });
  assert.equal(on.svc.ownerLaneFor('group:123456789'), true);
  const off = makeCtx({ convStates: { 'group:123456789': { unread: [ownerMsg, other] } } });
  assert.equal(off.svc.ownerLaneFor('group:123456789'), false);
  const noOwner = makeCtx({ cfg: { ownerQQ: '' }, convStates: { 'group:1': { unread: [ownerMsg] } } });
  assert.equal(noOwner.svc.ownerLaneFor('group:1'), false);
  assert.equal(on.svc.ownerLaneFor('private:10001'), false, '私聊没有 owner lane');
});

test('isSessionAllowedInCurrentMode：key 形状不对或白名单不放行都 false', () => {
  const h = makeCtx();
  assert.equal(h.svc.isSessionAllowedInCurrentMode('group:123456789'), true);
  assert.equal(h.svc.isSessionAllowedInCurrentMode('group:123456789#owner'), true, 'owner 车道按基 key 判');
  assert.equal(h.svc.isSessionAllowedInCurrentMode('group:999'), false);
  assert.equal(h.svc.isSessionAllowedInCurrentMode('nonsense'), false);
  assert.equal(h.svc.isSessionAllowedInCurrentMode('private:10001'), true);
});

test('sessionPolicy / isCurrentSession：模式或 preset 变了旧会话立刻失效', () => {
  const h = makeCtx();
  const key = 'group:123456789';
  h.state.sessions[key] = 'sid-1';
  h.state.sessionPolicies[key] = h.svc.sessionPolicy(key);
  assert.equal(h.svc.isCurrentSession(key, 'sid-1'), true);
  assert.equal(h.svc.isCurrentSession(key, 'sid-2'), false, 'sessionId 不符');
  const changed = makeCtx({ mode: 'chat', state: { sessions: { [key]: 'sid-1' }, sessionPolicies: { [key]: h.svc.sessionPolicy(key) } } });
  assert.equal(changed.svc.isCurrentSession(key, 'sid-1'), false, '模式变了策略不同，旧会话不能复用');
});
