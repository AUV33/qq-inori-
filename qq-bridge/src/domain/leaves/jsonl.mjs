// jsonl.mjs · JSONL 读写的单一实现（P4 的前身：把散落的 readJsonl 收成一处）
//
// 背景：审计发现 6 处本地 readJsonl 各自实现（activity / behavior-ledger /
// learning-loop / overview / self-trend / quant/store），容错语义一致但写法各异，
// 改一处容易漏。这里统一成两个函数：
//   readJsonl(file)        —— 容错读：坏行/空行跳过，文件不存在返回 []（绝不上抛）
//   appendJsonl(file, obj) —— 追加一行 JSON（调用方负责目录存在）
//
// 设计：允许注入 fs（digest-service 等模块通过 ctx.fs 拿到的可能是测试桩），
// 所以两个函数都接受 { fs } 覆盖，默认真实 node:fs。

import fs from 'node:fs';

/**
 * 容错读取 JSONL。
 * @param {string} file
 * @param {{fs?:{readFileSync:Function}}} [deps]
 * @returns {any[]}
 */
export function readJsonl(file, deps = {}) {
  const io = deps.fs ?? fs;
  try {
    return String(io.readFileSync(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 追加一行 JSONL。
 * @param {string} file
 * @param {any} obj
 * @param {{fs?:{appendFileSync:Function}}} [deps]
 */
export function appendJsonl(file, obj, deps = {}) {
  const io = deps.fs ?? fs;
  io.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}
