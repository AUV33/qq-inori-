// probe-admin-tools.mjs · 用新建的 qq-chat-admin 会话确认 feed_posts / browse_posts 在工具面里
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/adapters/dsh-client.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader,
  prefix: cfg.dsh?.authPrefix,
});
const cwd = `${PROJECT_ROOT}/qq-bridge/state/tool-probe`;
fs.mkdirSync(cwd, { recursive: true });
const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-admin' }), 'session.create');
const sessionId = created.sessionId;
console.log('SESSION', sessionId);
const stream = api.events.mux({});
const collector = createTurnCollector();
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时')), 90_000);
  (async () => {
    for await (const envelope of stream) {
      const frame = envelope.payload;
      if (frame.type === 'session/event' && frame.sessionId === sessionId) {
        const ended = collector.push(frame.event);
        if (ended) { clearTimeout(timer); resolve(ended); return; }
      }
      if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error(JSON.stringify(frame.error))); return; }
    }
  })().catch((e) => { clearTimeout(timer); reject(e); });
});
stream.follow(sessionId);
await new Promise((r) => setTimeout(r, 1000));
unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '只输出你当前可用工具名的 JSON 数组，不要调用任何工具，不要发消息。' }] }), 'session.prompt');
const ended = await done;
const text = String(ended.text || '');
console.log('has feed_posts =', text.includes('feed_posts'));
console.log('has browse_posts =', text.includes('browse_posts'));
console.log('has web_search =', text.includes('web_search'));
console.log(text.slice(0, 600));
try { await api.workspace.archiveSession({ sessionId }); console.log('archived'); } catch { /* ignore */ }
