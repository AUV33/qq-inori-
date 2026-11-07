// probe-preset-perms.mjs · 实测三种 preset 的工具面（她"全部权限"到底在哪些会话）
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/adapters/dsh-client.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader, prefix: cfg.dsh?.authPrefix,
});
const cwd = `${PROJECT_ROOT}/qq-bridge/state/tool-probe`;
fs.mkdirSync(cwd, { recursive: true });

const presets = ['qq-chat', 'qq-chat-v2', 'qq-chat-admin'];
const out = {};
for (const preset of presets) {
  let names = [];
  let sid = null;
  try {
    const created = unwrap(await api.sessions.create({ cwd, agentPreset: preset }), 'session.create');
    sid = created.sessionId;
    const stream = api.events.mux({});
    const collector = createTurnCollector();
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时')), 90_000);
      (async () => {
        for await (const envelope of stream) {
          const frame = envelope.payload;
          if (frame.type === 'session/event' && frame.sessionId === sid) {
            const ended = collector.push(frame.event);
            if (ended) { clearTimeout(timer); resolve(ended); return; }
          }
          if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame.error))); return; }
        }
      })().catch((e) => { clearTimeout(timer); reject(e); });
    });
    stream.follow(sid);
    await new Promise((r) => setTimeout(r, 800));
    unwrap(await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: '只输出你当前可用工具名的 JSON 数组，不要调用任何工具。' }] }), 'session.prompt');
    const ended = await done;
    const text = String(ended.text || '');
    try { names = JSON.parse(text); } catch { names = (text.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)); }
  } catch (e) {
    names = [`ERROR: ${e?.message ?? e}`];
  }
  const has = (re) => names.some((n) => re.test(n));
  out[preset] = {
    count: names.length,
    pwsh: has(/^pwsh$/), read: has(/^read$/), write: has(/^write$/), edit: has(/^edit$/),
    glob: has(/^glob$/), grep: has(/^grep$/), subagent: has(/^subagent/),
    phone: has(/phone_/), qqSend: has(/qq_send_message|qq_send_to/), web: has(/web_search|web_fetch/),
    names,
  };
  console.log(preset, '| 工具数', names.length, '| pwsh', out[preset].pwsh, 'read', out[preset].read, 'write', out[preset].write, 'phone', out[preset].phone, 'qqSend', out[preset].qqSend);
  if (sid) { try { await api.workspace.archiveSession({ sessionId: sid }); } catch { /* ignore */ } }
}
fs.writeFileSync(`${PROJECT_ROOT}/_tmp/preset-perms.json`, JSON.stringify(out, null, 1));
console.log('saved _tmp/preset-perms.json');
