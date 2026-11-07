import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 实测 phone_look：单帧 + 连拍 3 帧（模拟看视频）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 凭据只从环境注入：任何 API key 字面量都会让发布闸门变红，且历史里的字面量无法靠删除文件撤销。
const KEY = process.env.PHONE_VISION_KEY;
if (!KEY) {
  console.error('缺少 PHONE_VISION_KEY：请在环境变量里提供视觉模型密钥后再运行本自测。');
  process.exit(2);
}

const client = new Client({ name: 'look-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'packages/phone-mcp/src/phone-mcp.js')],
  env: {
    ...process.env,
    PHONE_ADB: process.env.PHONE_ADB ?? 'adb',
    PHONE_VISION_KEY: KEY,
    PHONE_VISION_MODEL: 'deepseek-flash',
    PHONE_VISION_MAX_TOKENS: '2000',
  },
}));

const tools = await client.listTools();
console.log('工具清单含 phone_look =', tools.tools.some((t) => t.name === 'phone_look'));

const call = async (label, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name: 'phone_look', arguments: args });
  const body = (r.content ?? []).map((c) => c.text ?? '').join(' ');
  console.log(`\n[${label}] ${Date.now() - t0}ms  ${r.isError ? 'ERROR' : 'OK'}`);
  console.log('  ' + body.slice(0, 600).replace(/\n/g, '\n  '));
};

await call('单帧：现在屏幕上是什么', { question: '现在手机屏幕上是什么界面？有哪些文字？' });
await call('连拍 3 帧：看有没有在动', { question: '这是连续 3 帧，画面有变化吗？在发生什么？', frames: 3, intervalMs: 2000 });

await client.close();
