import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-phone-vision-tools.mjs · 通过 phone-mcp stdio 实测新工具（真机）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'phone-vision-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/phone-mcp/src/phone-mcp.js")],
  env: { ...process.env, PHONE_ADB: path.join(REPO_ROOT, "/tools/platform-tools/adb.exe") },
}));
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
for (const n of ['phone_ocr', 'phone_find_template', 'phone_tap_template', 'phone_template_save', 'phone_templates']) {
  console.log('tool', n, '=', names.includes(n));
}
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
try {
  const tpl = await client.callTool({ name: 'phone_templates', arguments: {} });
  console.log('templates →', txt(tpl).slice(0, 200));
} catch (e) { console.log('templates err', e?.message); }
try {
  const t0 = Date.now();
  const r = await client.callTool({ name: 'phone_ocr', arguments: { max: 20 } });
  console.log(`OCR ${Date.now() - t0}ms →`, txt(r).slice(0, 600));
} catch (e) { console.log('ocr err', e?.message); }
await client.close();
