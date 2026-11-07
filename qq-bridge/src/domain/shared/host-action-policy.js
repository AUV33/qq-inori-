// host-action-policy.js · host_action 的 shell 命令安全策略（S1 安全收口）
//
// 把"在宿主机器上任意跑一条 PowerShell"收敛为：
//   · 仅白名单可执行（git/adb/重启相关/进程查询…），默认不含 powershell/cmd；
//   · 单语句，禁止链式/重定向/变量展开/子 shell（防"一条命令"变任意代码执行）；
//   · 白名单可由配置 hostActionAllow 或环境变量 QQ_HOST_ACTION_ALLOW 追加。
//
// 设计取舍：这是为了把"爆炸半径"从"整台电脑"降到"几个被点名的运维命令"。
// 真要跑复杂脚本，请走专门的、被审计的脚本入口，而不是把任意字符串喂给 powershell。

import process from 'node:process';
// [PHYSICAL-POLICY] 宪章 §4.2 的四条物理底线：白名单之外的最后一道语义边界。
import { evaluate as evaluatePhysical } from './physical-policy.mjs';

// 默认只放行"只读/运维类"可执行；不放 powershell/cmd（否则白名单形同虚设）。
export const DEFAULT_HOST_SHELL_ALLOWLIST = [
  'git', 'adb', 'schtasks', 'qprocess', 'tasklist', 'where',
  'ping', 'ipconfig', 'netstat', 'netsh', 'sc', 'net',
  'ver', 'systeminfo', 'wmic', 'taskkill', 'robocopy', 'xcopy', 'copy', 'move',
];

export function getHostShellAllowlist({ allow } = {}) {
  const fromEnv = String(process.env.QQ_HOST_ACTION_ALLOW || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fromCfg = Array.isArray(allow) ? allow.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];
  return new Set([...DEFAULT_HOST_SHELL_ALLOWLIST, ...fromEnv, ...fromCfg]);
}

// 禁止的字符：链式(; &)、管道(|)、重定向(< >)、变量展开($)、子 shell(`)、换行、括号/方括号（防止 () 分组与 ${} 注入）。
const INJECTION_CHARS = /[;&|<>$`\n\r(){}[\]]/;

/**
 * 校验 host_action 的 shell 命令。
 * @param {string} command
 * @param {{allowlist?:Set<string>}} [opts]
 * @returns {{ok:boolean, error?:string, exe?:string}}
 */
export function validateHostShell(command, { allowlist, actor = 'her' } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) return { ok: false, error: 'command 不能为空' };
  if (raw.length > 4000) return { ok: false, error: 'command 过长（上限 4000 字）' };
  if (INJECTION_CHARS.test(raw)) {
    return { ok: false, error: 'command 含禁止字符（; & | < > $ ` 换行 括号 方括号），不允许链式/注入' };
  }
  // [PHYSICAL] 白名单能放行的命令也可能有真实后果（robocopy /MIR 会删目标多余文件）。
  const physical = evaluatePhysical({ kind: 'shell', actor, command: raw });
  if (!physical.allow) {
    return { ok: false, error: `物理层拒绝（${physical.code}）：${physical.reason}`, policy: physical.code };
  }
  const exe = raw.split(/\s+/)[0] || '';
  const base = exe.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1|psm1)$/i, '').toLowerCase();
  const set = allowlist instanceof Set ? allowlist : getHostShellAllowlist();
  if (!set.has(base)) {
    return { ok: false, error: `command 可执行不在白名单：「${base}」。允许的：${[...set].join('/')}` };
  }
  // [F5] 命令名过了白名单，仍可能有「只读命令名 + 危险参数」的逃逸面：
  //   · git -c 'alias.x=!sh -c ...' / git alias / hook / !shell 逃逸 / 单引号
  //   · robocopy /MIR / /PURGE 会删除目标目录的多余文件
  // 这些参数模式不在白名单语义内，默认拒绝（要跑复杂/破坏性脚本请走专门、被审计的脚本入口）。
  const DANGEROUS_ARGS = {
    git: [/-c\b/, /alias/, /hook/, /!/, /'/],
    robocopy: [/\/mir/i, /\/purge/i, /\/mov/i, /\/move/i],
  };
  const danger = DANGEROUS_ARGS[base];
  if (danger && danger.some((re) => re.test(raw))) {
    return { ok: false, error: `command 含危险参数（${base}），被 host-action 策略拒绝；如需请走专门脚本入口` };
  }
  return { ok: true, exe: base };
}
