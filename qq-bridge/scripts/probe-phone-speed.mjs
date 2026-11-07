// probe-phone-speed.mjs · 手机操作耗时探针（改造后）：dump / 缓存复用 / tap 验证 / batch / look
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = `${PROJECT_ROOT}/ai-companion-kit/packages/phone-mcp`;
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/phone-mcp.js')], cwd: ROOT, env: { ...process.env, PHONE_ADB: `${PROJECT_ROOT}/tools/platform-tools/adb.exe` }, stderr: 'pipe' });
const client = new Client({ name: 'phone-speed-probe', version: '0.0.0' });
const timeIt = async (name, fn) => {
  const t0 = Date.now();
  let res = null;
  try { res = await fn(); } catch (e) { res = { error: e?.message ?? String(e) }; }
  console.log(`${name.padEnd(26)} ${String(Date.now() - t0).padStart(6)} ms`);
  return res;
};
try {
  await client.connect(transport);
  await timeIt('phone_dump (冷 dump)', () => client.callTool({ name: 'phone_dump', arguments: { max: 20 } }));
  await timeIt('phone_tap_text (复用缓存)', () => client.callTool({ name: 'phone_tap_text', arguments: { text: '_no_such_element_' } }));
  await timeIt('phone_tap verify (5,5)', () => client.callTool({ name: 'phone_tap', arguments: { x: 5, y: 5 } }));
  await timeIt('phone_batch (wait 100ms)', () => client.callTool({ name: 'phone_batch', arguments: { actions: [{ op: 'wait', ms: 100 }], endShot: true } }));
  await timeIt('phone_look (画面)', () => client.callTool({ name: 'phone_look', arguments: {} }));
  await timeIt('phone_screenshot', () => client.callTool({ name: 'phone_screenshot', arguments: {} }));
} finally {
  try { await client.close(); } catch { /* ignore */ }
}
