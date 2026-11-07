// judge-phone.mjs · 手机状态的机检器（给技能判据用）
//
// 用法（技能里的 verify 写成 `命令: node qq-bridge/scripts/judge-phone.mjs <spec>`）：
//   pkg:<包名>                 当前前台是不是这个包（dumpsys mCurrentFocus）
//   text:<字>                  当前屏幕 OCR 里有这段字
//   textAny:<字1>|<字2>|...     OCR 里任意一个命中
//   nottext:<字>                OCR 里没有这段字
//   file:<路径>                 文件/目录存在
// 退出码：0=命中 / 1=没命中 / 2=没条件检查（识别服务没起、adb 没设备等）
// 输出一行 JSON 作为证据（skill_verify 会把 evidence 记到技能上）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ADB = `${PROJECT_ROOT}/tools/platform-tools/adb.exe`;
const VISION = 'http://127.0.0.1:8791';
const TMP = `${PROJECT_ROOT}/_tmp/judge-phone`;

const run = (args, timeout = 15000) => new Promise((resolve) => {
  execFile(ADB, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
  });
});

async function screenshot() {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `shot-${Date.now()}.png`);
  const r = await new Promise((resolve) => {
    const cp = execFile(ADB, ['exec-out', 'screencap', '-p'], { timeout: 20000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => resolve({ ok: !err, buf: stdout }));
    void cp;
  });
  if (!r.ok || !r.buf?.length) return null;
  fs.writeFileSync(file, r.buf);
  return file;
}

async function ocrText(shot) {
  // [AUTOSTART] 识别服务没起就拉起来（与 phone-mcp 共用 venv/脚本），等最多 20 秒。
  let health = await fetch(`${VISION}/health`, { signal: AbortSignal.timeout(1200) }).catch(() => null);
  if (!health?.ok) {
    try {
      const py = `${PROJECT_ROOT}/ai-companion-kit/packages/phone-mcp/.venv/Scripts/python.exe`;
      const srv = `${PROJECT_ROOT}/ai-companion-kit/packages/phone-mcp/vision/phone_vision_server.py`;
      if (fs.existsSync(py)) {
        const { spawn } = await import('node:child_process');
        const cp = spawn(py, [srv], { detached: true, stdio: 'ignore', windowsHide: true });
        cp.unref?.();
        for (let i = 0; i < 40; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          health = await fetch(`${VISION}/health`, { signal: AbortSignal.timeout(800) }).catch(() => null);
          if (health?.ok) break;
        }
      }
    } catch { /* 起不来就算了，下面报没条件检查 */ }
  }
  if (!health?.ok) return { ok: false, text: '', why: '识别服务没起（手机视觉 8791）' };
  const res = await fetch(`${VISION}/ocr`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: shot }), signal: AbortSignal.timeout(60000),
  }).catch(() => null);
  if (!res?.ok) return { ok: false, text: '', why: 'OCR 请求失败' };
  const j = await res.json().catch(() => null);
  const text = (j?.items || []).map((x) => x.text).join(' ');
  return { ok: true, text, why: '' };
}

const spec = String(process.argv.slice(2).join(' ') || '').trim();
const m = /^(pkg|text|textAny|nottext|file)\s*[:：]\s*(.+)$/i.exec(spec);
const done = (code, evidence) => {
  console.log(JSON.stringify({ ok: code === 0, code, spec, evidence: String(evidence).slice(0, 240) }));
  process.exit(code);
};

async function main() {
  if (!m) return done(2, '判据格式不对：应为 pkg:/text:/textAny:/nottext:/file:');
  const kind = m[1].toLowerCase();
  const arg = m[2].trim();

  if (kind === 'file') {
    return fs.existsSync(arg) ? done(0, `文件存在：${arg}`) : done(1, `文件不存在：${arg}`);
  }
  if (kind === 'pkg' && !/^[a-z0-9_.]+$/i.test(arg)) return done(2, '包名不合法');

  const devices = await run(['devices']);
  if (!/device\s*$/m.test(devices.out.replace(/\r/g, ''))) return done(2, 'adb 没有可用设备');

  if (kind === 'pkg') {
    const w = await run(['shell', 'dumpsys', 'window']);
    const focus = (/mCurrentFocus[^\n]*/.exec(w.out)?.[0] || '').slice(0, 200);
    return focus.includes(arg) ? done(0, `前台包含 ${arg}｜${focus}`) : done(1, `前台不是 ${arg}｜${focus}`);
  }

  const shot = await screenshot();
  if (!shot) return done(2, '截图失败（adb 没返回画面）');
  const ocr = await ocrText(shot);
  if (!ocr.ok) return done(2, ocr.why);
  const text = ocr.text.replace(/\s+/g, ' ');
  if (kind === 'text') return text.includes(arg) ? done(0, `屏幕有「${arg}」`) : done(1, `屏幕没有「${arg}」（读到：${text.slice(0, 80)}）`);
  if (kind === 'nottext') return !text.includes(arg) ? done(0, `屏幕确实没有「${arg}」`) : done(1, `屏幕出现了「${arg}」`);
  if (kind === 'textany' || kind === 'textany') {
    const opts = arg.split(/[|,]/).map((x) => x.trim()).filter(Boolean);
    const hit = opts.find((o) => text.includes(o));
    return hit ? done(0, `屏幕有「${hit}」`) : done(1, `屏幕没有 ${opts.join('/')}（读到：${text.slice(0, 80)}）`);
  }
  return done(2, `不认识的判据：${kind}`);
}

main().catch((e) => done(2, `机检异常：${e?.message ?? e}`));
