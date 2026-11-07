// 文件读写基础件：容错 JSON、原子写、Windows 重命名重试。
//
// 从 app.mjs 的 main() 外提（2026-11-02，开放源码架构收敛）。只依赖 node:fs/path/crypto，
// 不依赖任何运行态；所有调用方直接 import。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * JSON.parse 对字面量 `null` 是成功的；`?? {}` 兜底会在回写时抹掉整份配置，
 * 所以不是普通对象就抛错，让调用方 500，绝不回写。
 */
export function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：Windows 上覆盖正被打开的文件会抛 EPERM/EBUSY/EACCES，退避重试几次。
 */
export function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'fs-utils.mjs'); }
    }
  }
  throw lastError;
}

// 原子写 JSON：唯一临时文件 + rename，失败清理临时文件。
export function atomicWriteJson(file, obj, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    // [COMPACT-JSON] 状态文件在热路径上同步写（social-v2.json 实测 ~390KB / 97 个调用点），
    // 2 空格缩进白占 ~25% 字节和 stringify 时间。这些文件只给程序读，紧凑写。
    // [PRETTY] 少数给人看的状态文件（温度/日程等）传 pretty:true，输出保持 2 空格缩进。
    fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 2 : 0) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'fs-utils.mjs'); }
    throw error;
  }
}

// 原子写文本文件。
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'fs-utils.mjs'); }
    throw error;
  }
}
