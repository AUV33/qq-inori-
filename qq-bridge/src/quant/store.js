// quant/store.js · 量化模块自己的落盘小工具（不依赖 ai-companion-kit）
//
// 为什么单独一份：Phase 1 的设计约束是「纯 Node，零外部依赖」，这样：
//   1) 被单测 / 审计 fixture 拷走时不需要连带拷 ai-companion-kit；
//   2) MCP 子进程少一条深层相对 import，路径搬家不容易断。
//
// 并发：写入方各自唯一（account/journal/cache 都由同一个 MCP 进程写），
// 桥接只读账户，所以这里不做跨进程锁——原子 rename 足够防"读到半截 JSON"。

import fs from 'node:fs';
import path from 'node:path';

/** 原子写 JSON（tmp → rename） */
export function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
