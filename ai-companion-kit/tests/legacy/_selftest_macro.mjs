import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 验证 phone_macro 连招：一次调用多步、存宏、重放，并测耗时
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'macro-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO_ROOT, "//ai-companion-kit//packages//phone-mcp//src//phone-mcp.js")],
  env: { ...process.env, PHONE_ADB: path.join(REPO_ROOT, "//tools//platform-tools//adb.exe") },
}));

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await Promise.race([
    client.callTool({ name, arguments: args }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 60s')), 60000)),
  ]);
  const ms = Date.now() - t0;
  const txt = (r.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 220);
  console.log(`[${ms} ms] ${name} -> ${r.isError ? 'ERROR ' : ''}${txt}`);
  return { ms, txt, isError: !!r.isError };
};

console.log('=== 1) 单步：一次 tap（基准）===');
const single = await call('phone_macro', { actions: [{ type: 'key', key: 'home' }] });

console.log('\n=== 2) 连招：一次调用 5 个动作 ===');
const chain = await call('phone_macro', {
  actions: [
    { type: 'key', key: 'home' },
    { type: 'sleep', ms: 300 },
    { type: 'swipe', x: 540, y: 1600, x2: 540, y2: 900, ms: 150 },
    { type: 'sleep', ms: 200 },
    { type: 'key', key: 'home' },
  ],
  stepMs: 150,
});

console.log('\n=== 3) 存成命名宏 ===');
await call('phone_macro', {
  actions: [{ type: 'key', key: 'home' }, { type: 'sleep', ms: 200 }, { type: 'key', key: 'home' }],
  saveAs: 'selftest_home',
});

console.log('\n=== 4) 列出宏 ===');
const list = await call('phone_macro', { listMacros: true });

console.log('\n=== 5) 一句话重放 ===');
await call('phone_macro', { playName: 'selftest_home' });

console.log('\n=== 6) repeat 重复 3 次（一次调用干 9 个动作）===');
await call('phone_macro', {
  actions: [{ type: 'key', key: 'home' }, { type: 'sleep', ms: 100 }, { type: 'key', key: 'home' }],
  repeat: 3,
  repeatGapMs: 100,
  stepMs: 100,
});

await client.close();
console.log('\n单步基准 =', single.ms, 'ms；5 步连招 =', chain.ms, 'ms');
console.log('若逐条调用，5 步需要 5 次模型往返 + 5 次工具调用；连招只需 1 次。');
