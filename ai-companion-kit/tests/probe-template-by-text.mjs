import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// probe-template-by-text.mjs · 真机：按文字存模板 → 列表 → 找它
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'tpl-probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "/ai-companion-kit/packages/phone-mcp/src/phone-mcp.js")],
  env: { ...process.env, PHONE_ADB: path.join(REPO_ROOT, "/tools/platform-tools/adb.exe") },
}));
const txt = (r) => (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');

const ocr = await client.callTool({ name: 'phone_ocr', arguments: { max: 8 } });
const ocrText = txt(ocr);
console.log('OCR →', ocrText.slice(0, 400));
// 从 OCR 结果里挑第一行文字当目标
const m = /0: "([^"]+)"/.exec(ocrText);
const target = m ? m[1] : '';
console.log('target =', target);
if (target) {
  const save = await client.callTool({ name: 'phone_template_save', arguments: { name: 'probe_by_text', text: target, note: '按文字存的测试模板' } });
  console.log('SAVE →', txt(save).slice(0, 300));
  const list = await client.callTool({ name: 'phone_templates', arguments: {} });
  console.log('LIST →', txt(list).slice(0, 300));
  const find = await client.callTool({ name: 'phone_find_template', arguments: { name: 'probe_by_text', threshold: 0.7 } });
  console.log('FIND →', txt(find).slice(0, 300));
}
await client.close();
