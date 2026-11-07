// set-effort-low.mjs · 把所有会话的默认思考档切到 low，并给现有会话补一次 selectModel
import fs from 'node:fs';

// 1) config：默认思考档 low
const F = `${PROJECT_ROOT}/qq-bridge/config.json`;
const raw = fs.readFileSync(F, 'utf8');
const cfg = JSON.parse(raw);
fs.writeFileSync(F + '.bak-effort-low', raw, 'utf8');
cfg.dsh = cfg.dsh || {};
cfg.dsh.reasoningEffort = 'low';
cfg.socialV2 = cfg.socialV2 || {};
cfg.socialV2.taskPool = cfg.socialV2.taskPool || {};
cfg.socialV2.taskPool.reasoningEffort = 'low';
fs.writeFileSync(F, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('config: dsh.reasoningEffort = low; taskPool.reasoningEffort = low');

// 2) 迁移现有会话
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/adapters/dsh-client.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader, prefix: cfg.dsh?.authPrefix,
});
const STATE = `${PROJECT_ROOT}/qq-bridge/state`;
const ids = new Set();
try {
  const s = JSON.parse(fs.readFileSync(`${STATE}/sessions.json`, 'utf8'));
  for (const id of Object.values(s.sessions || {})) if (id) ids.add(id);
} catch { /* 没有会话表 */ }
for (const f of fs.readdirSync(STATE).filter((x) => /^isolated-.*\.json$/.test(x) && x !== 'isolated-dead.json')) {
  try { const j = JSON.parse(fs.readFileSync(`${STATE}/${f}`, 'utf8')); if (j?.sessionId) ids.add(j.sessionId); } catch { /* ignore */ }
}
try {
  const tp = JSON.parse(fs.readFileSync(`${STATE}/task-pool.json`, 'utf8'));
  for (const t of (tp.running || [])) if (t?.sessionId) ids.add(t.sessionId);
} catch { /* ignore */ }

const provider = String(cfg.dsh?.provider || 'deepseek-official');
const model = String(cfg.dsh?.model || 'deepseek-flash');
let ok = 0;
for (const sessionId of ids) {
  try {
    const r = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: 'low' }), 'selectModel');
    console.log(`✓ ${sessionId.slice(0, 18)} -> ${r.selected.provider}/${r.selected.model} (${r.selected.reasoningEffort ?? '?'})`);
    ok += 1;
  } catch (e) {
    console.log(`✗ ${sessionId.slice(0, 18)}: ${e?.message ?? e}`);
  }
}
console.log(`done: ${ok}/${ids.size} sessions set to low`);
