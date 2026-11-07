// probe-phone-vision.mjs · 用 MCP stdio 客户端拉起 phone-mcp，实测 phone_look / phone_screenshot 是否把「画面本身」返回
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = `${PROJECT_ROOT}/ai-companion-kit/packages/phone-mcp`;
const script = path.join(ROOT, 'src/phone-mcp.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [script],
  cwd: ROOT,
  env: { ...process.env, PHONE_ADB: `${PROJECT_ROOT}/tools/platform-tools/adb.exe` },
  stderr: 'pipe',
});
const client = new Client({ name: 'phone-vision-probe', version: '0.0.0' });
let failures = 0;
const check = (name, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`); if (!ok) failures++; };

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('phone_look 已注册', names.includes('phone_look'));
  check('phone_screenshot 已注册', names.includes('phone_screenshot'));
  check('phone_tap 已注册', names.includes('phone_tap'));
  const look = tools.find((t) => t.name === 'phone_look');
  check('phone_look 描述说明直给画面', /画面本身/.test(String(look?.description ?? '')), String(look?.description ?? '').slice(0, 60));

  const r1 = await client.callTool({ name: 'phone_look', arguments: {} });
  const imgs1 = (r1.content ?? []).filter((c) => c.type === 'image');
  const txt1 = (r1.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  check('phone_look 返回图片内容', imgs1.length >= 1, `images=${imgs1.length}, bytes≈${imgs1[0]?.data?.length ?? 0}`);
  check('phone_look 图片是 PNG', (imgs1[0]?.mimeType ?? '') === 'image/png');
  check('phone_look 未额外调用视觉 API（无转述尾巴）', !/api_prompt=/.test(txt1), txt1.slice(0, 80));

  const r2 = await client.callTool({ name: 'phone_screenshot', arguments: {} });
  const imgs2 = (r2.content ?? []).filter((c) => c.type === 'image');
  check('phone_screenshot 返回图片内容（不再只有路径）', imgs2.length >= 1, `images=${imgs2.length}, bytes≈${imgs2[0]?.data?.length ?? 0}`);

  const r3 = await client.callTool({ name: 'phone_dump', arguments: { max: 5 } });
  const txt3 = (r3.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  check('phone_dump 仍返回可点元素清单', /共 \d+ 个元素/.test(txt3), txt3.slice(0, 60));
} catch (error) {
  console.log('FAIL 探针异常：', error?.message ?? error);
  failures++;
} finally {
  try { await client.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? '\nPHONE-VISION PROBE OK' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
