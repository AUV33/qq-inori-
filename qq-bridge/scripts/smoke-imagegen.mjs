// 一次性冒烟：拉起 sd-server（指定模型）→ 出一张 512x768 → 打印耗时/显存/内存 → 关掉。
// 用法：node scripts/smoke-imagegen.mjs [模型路径] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(ROOT, '..', 'tools', 'sd-vulkan', 'sd-server.exe');
const model = process.argv[2] && !process.argv[2].startsWith('--')
  ? path.resolve(process.argv[2])
  : path.join(ROOT, '..', 'tools', 'sd-models', 'anything-v3-q8.gguf');
const port = 8199;
const keep = process.argv.includes('--keep');

if (!fs.existsSync(bin)) { console.error('缺 sd-server：', bin); process.exit(2); }
if (!fs.existsSync(model)) { console.error('缺模型：', model); process.exit(2); }
console.log('bin:', bin);
console.log('model:', model, (fs.statSync(model).size / 1e6).toFixed(0) + 'MB');
console.log('可用内存:', Math.round(os.freemem() / 1048576) + 'MB');

const args = ['-m', model, '--listen-ip', '127.0.0.1', '--listen-port', String(port), '--vae-tiling', '--log-level', 'info'];
const started = Date.now();
const proc = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
proc.stdout.on('data', (b) => { const s = String(b); if (!ready || /error|warn/i.test(s)) process.stdout.write('out> ' + s.slice(0, 400)); });
proc.stderr.on('data', (b) => process.stdout.write('err> ' + String(b).slice(0, 600)));
proc.on('exit', (c, s) => { if (!ready) console.log(`sd-server 提前退出 code=${c} signal=${s}`); });

async function j(pathname, init = {}, timeout = 10000) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  return data;
}

try {
  for (let i = 0; i < 240; i += 1) {
    if (proc.exitCode !== null) throw new Error('服务退出了');
    try { await j('/sdapi/v1/progress', {}, 2000); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!ready) throw new Error('等待就绪超时');
  const startupMs = Date.now() - started;
  console.log(`就绪：${(startupMs / 1000).toFixed(1)}s；可用内存 ${Math.round(os.freemem() / 1048576)}MB`);

  const t0 = Date.now();
  const data = await j('/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: '1girl, silver hair, white dress, night sky, stars, cinematic lighting, detailed',
      negative_prompt: 'lowres, bad anatomy, bad hands, text, watermark, blurry',
      width: 512, height: 768, steps: 24, cfg_scale: 7, seed: 12345, batch_size: 1
    })
  }, 300000);
  const genMs = Date.now() - t0;
  const b64 = data?.images?.[0] ?? '';
  const buf = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const out = path.join(ROOT, '..', '_tmp', 'smoke-imagegen.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`出图：${(genMs / 1000).toFixed(1)}s，${(buf.length / 1024).toFixed(0)}KB → ${out}`);
  console.log('可用内存（出图后）:', Math.round(os.freemem() / 1048576) + 'MB');
  console.log('SMOKE_OK');
} finally {
  if (!keep) proc.kill();
  else console.log('（--keep：服务留着，端口', port, '）');
}
