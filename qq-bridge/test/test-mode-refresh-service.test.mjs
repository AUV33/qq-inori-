// mode-refresh-service 金标：优先 DSH settings，缺字段回落本地 mode.json；ownerQQ 非法只记日志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModeRefresh } from '../src/domain/conversation/mode-refresh-service.mjs';

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mode-'));
  const state = {
    logs: [], mode: null, closedPreset: null, dshDefaultPreset: null, presetIds: null,
    cfg: { ownerQQ: 10001 },
  };
  const settings = overrides.settings ?? { namespaces: [] };
  const svc = createModeRefresh({
    api: {
      settings: { describe: async () => ({ result: { ok: true, value: settings } }) },
      agentPresets: { list: async () => (overrides.presets ?? { result: { ok: true, value: { presets: [] } } }) },
    },
    unwrap: (r, label) => { if (!r?.result?.ok) throw new Error(`${label} failed`); return r.result.value; },
    cfg: state.cfg,
    log: (m) => state.logs.push(String(m)),
    STATE_DIR: dir,
    readJsonSafe: (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } },
    normalizeModeInput: (v) => (['chat', 'closed-agent', 'reserved', 'reserved2'].includes(v) ? v : null),
    normalizeOwnerQQ: (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 非法'); return n; },
    setCurrentMode: (m) => { state.mode = m; },
    getDshDefaultPreset: () => state.dshDefaultPreset,
    setDshDefaultPreset: (p) => { state.dshDefaultPreset = p; },
    setClosedAgentPreset: (p) => { state.closedPreset = p; },
    setDshPresetIds: (ids) => { state.presetIds = ids; },
    ...overrides.ctxExtra,
  });
  return { svc, state, dir };
}

const writeLocal = (dir, obj) => fs.writeFileSync(path.join(dir, 'mode.json'), JSON.stringify(obj));

test('refreshMode：读 DSH 的 qq-mode，并带出 agent-presets 默认 preset', async () => {
  const h = makeCtx({
    settings: {
      namespaces: [
        { ns: 'agent-presets', value: { default: 'qq-chat' } },
        { ns: 'qq-mode', value: { mode: 'reserved2', ownerQQ: '123456' } },
      ],
    },
  });
  await h.svc.refreshMode();
  assert.equal(h.state.mode, 'reserved2');
  assert.equal(h.state.dshDefaultPreset, 'qq-chat');
  assert.equal(h.state.cfg.ownerQQ, 123456);
});

test('refreshMode：DSH 的 ownerQQ 非法只记日志，不覆盖 config', async () => {
  const h = makeCtx({
    settings: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat', ownerQQ: 'abc' } }] },
  });
  await h.svc.refreshMode();
  assert.equal(h.state.mode, 'chat');
  assert.equal(h.state.cfg.ownerQQ, 10001);
  assert.ok(h.state.logs.some((l) => l.includes('ownerQQ 无效')));
});

test('refreshMode：DSH 有模式时仍从本地读 closedAgentPreset（控制台下拉不能变死设置）', async () => {
  const h = makeCtx({ settings: { namespaces: [{ ns: 'qq-mode', value: { mode: 'reserved2' } }] } });
  writeLocal(h.dir, { closedAgentPreset: 'qq-chat-admin' });
  await h.svc.refreshMode();
  assert.equal(h.state.closedPreset, 'qq-chat-admin');
});

test('refreshMode：DSH 没有 qq-mode 时回落本地 mode.json', async () => {
  const h = makeCtx({ settings: { namespaces: [] } });
  writeLocal(h.dir, { mode: 'closed-agent', closedAgentPreset: 'qq-chat' });
  await h.svc.refreshMode();
  assert.equal(h.state.mode, 'closed-agent');
  assert.equal(h.state.closedPreset, 'qq-chat');
});

test('refreshMode：DSH 抛错/返回坏结构也回落本地，不炸', async () => {
  const h = makeCtx({ settings: { namespaces: null } });
  writeLocal(h.dir, { mode: 'chat' });
  await assert.doesNotReject(() => h.svc.refreshMode());
  assert.equal(h.state.mode, 'chat');
});

test('refreshMode：本地也没有/非法时不改当前模式', async () => {
  const h = makeCtx({ settings: { namespaces: [] } });
  writeLocal(h.dir, { mode: '不认识的模式' });
  await h.svc.refreshMode();
  assert.equal(h.state.mode, null);
});

test('refreshPresetList：拉清单写入 ids；没有默认值时用 isDefault 标记的', async () => {
  const h = makeCtx({ presets: { result: { ok: true, value: { presets: [{ id: 'a' }, { id: 'qq-chat', isDefault: true }] } } } });
  await h.svc.refreshPresetList();
  assert.deepEqual(h.state.presetIds, ['a', 'qq-chat']);
  assert.equal(h.state.dshDefaultPreset, 'qq-chat');
});

test('refreshPresetList：已有默认 preset 时不覆盖；拉取失败只记日志', async () => {
  const h = makeCtx({ presets: { result: { ok: true, value: { presets: [{ id: 'x', isDefault: true }] } } } });
  h.state.dshDefaultPreset = '已存在';
  await h.svc.refreshPresetList();
  assert.equal(h.state.dshDefaultPreset, '已存在');

  const bad = makeCtx({ presets: { result: { ok: false } } });
  await assert.doesNotReject(() => bad.svc.refreshPresetList());
  assert.ok(bad.state.logs.some((l) => l.includes('获取 DSH preset 列表失败')));
});
