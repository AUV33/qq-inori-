// [P1-3 启动指纹] 回答两个以前答不了的问题：现在跑的是哪一版？怎么起来的？
//
// crash.log 的 [startup] 行以前只有 `pid/rss/node`，于是「18 次启动没有 [exit]」里
// 分不清是旧版还是新版、是手动开的还是看门狗拉的。这里把三样东西钉进启动行：
//   rev = git rev-parse --short HEAD（代码版本）
//   cfg = config.json 的 sha1 前 8 位（配置版本；config.json 不入库，git 指纹覆盖不到）
//   src = 启动来源（manual / watchdog-vbs / watchdog-direct / restart / task）
//
// 纪律：全部可注入、全部降级 unknown——指纹算不出来绝不能拖慢或挡住桥接启动。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const UNKNOWN = 'unknown';

/** 允许的启动来源；环境变量里出现别的值一律记 unknown，避免把任意字符串写进日志。 */
const LAUNCH_SOURCES = new Set(['manual', 'watchdog-vbs', 'watchdog-direct', 'restart', 'task', 'unknown']);

/** sha1 取前 N 位：config.json 的短指纹。 */
export function sha1Short(input, len = 8) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, len);
}

/**
 * git 短 HEAD。exec 可注入（单测不碰真仓库）。
 * 只接受十六进制短哈希；产物带脏标记（如 `1695739-dirty`）时取其哈希部分。
 */
export function readGitRev({ root, exec = execFileSync, timeoutMs = 2000 } = {}) {
  if (!root) return UNKNOWN;
  try {
    const out = exec('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const matched = String(out ?? '').trim().match(/^([0-9a-f]{4,40})(?:-dirty)?$/i);
    return matched ? matched[1] : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** config.json 内容指纹。readFile 可注入。 */
export function readConfigSha({ configPath, readFile = fs.readFileSync } = {}) {
  if (!configPath) return UNKNOWN;
  try {
    return sha1Short(readFile(configPath));
  } catch {
    return UNKNOWN;
  }
}

/** 环境变量里的启动来源；未设置视为手动启动。 */
export function resolveLaunchSource(env = process.env) {
  const raw = String(env?.BRIDGE_LAUNCH_SOURCE ?? '').trim().toLowerCase();
  if (!raw) return 'manual';
  if (LAUNCH_SOURCES.has(raw)) return raw;
  return UNKNOWN;
}

/** 组装一份启动指纹；任何一项失败都只降级该项，不抛错。 */
export function buildStartupFingerprint({ root, configPath, env = process.env, exec, readFile } = {}) {
  return {
    rev: readGitRev({ root, exec }),
    cfg: readConfigSha({ configPath, readFile }),
    src: resolveLaunchSource(env),
  };
}

/** crash.log 行内格式：`rev=xxx cfg=yyy src=zzz`（单行、无空格歧义）。 */
export function formatFingerprint(fp = {}) {
  return `rev=${fp.rev ?? UNKNOWN} cfg=${fp.cfg ?? UNKNOWN} src=${fp.src ?? UNKNOWN}`;
}
