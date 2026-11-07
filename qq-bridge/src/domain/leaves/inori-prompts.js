// inori-prompts.js · 提示词热加载
//
// 为什么要有这个：原来 intake / reflect / own-life 的提示词写死在 .js 里，
// 改一个词就得重启桥接（会打断对话、还要等幽灵回合探测）。
// 现在把「可编辑的引导段」外置到 data/prompts/<name>.md：
//   · 每次取用时 stat 一下文件，mtime 变了就重读 —— 改文件立刻生效
//   · 文件不存在时回落到代码里的默认值，行为与改造前完全一致
//
// 纯函数 + 一个 mtime 缓存，零依赖。
import fs from 'node:fs';
import path from 'node:path';
import { projectPath } from '../shared/project-paths.js';

export const DEFAULT_DIR = process.env.PROMPT_DIR || projectPath('data', 'prompts');
const cache = new Map(); // 绝对路径 -> { mtimeMs, text }

export function promptPath(name, dir = DEFAULT_DIR) {
  return path.join(dir, `${name}.md`);
}

/**
 * 读一条提示词；文件不存在或为空则返回 fallback。
 * 每次调用都 stat，所以外部改文件后下一次调用就生效（无需重启）。
 */
export function loadText(name, fallback = '', dir = DEFAULT_DIR) {
  const file = promptPath(name, dir);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    if (!text) return fallback;
    cache.set(file, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return fallback;
  }
}


