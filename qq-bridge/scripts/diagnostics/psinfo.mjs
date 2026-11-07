// 只读诊断：查指定 PID 的命令行与进程名（原 scripts/_psinfo.mjs，2026-10-27 迁入 diagnostics/）
// 用法：node scripts/diagnostics/psinfo.mjs 1234 5678
import { execSync } from 'node:child_process';
const ids = process.argv.slice(2);
for (const id of ids) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${id}').CommandLine"`, { encoding: 'utf8', timeout: 15000 }).trim();
    const name = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${id}).ProcessName"`, { encoding: 'utf8', timeout: 15000 }).trim();
    console.log(`${id} [${name}] :: ${out.slice(0, 200)}`);
  } catch (e) {
    console.log(`${id} :: 读不到 (${e.message?.slice(0, 80)})`);
  }
}
