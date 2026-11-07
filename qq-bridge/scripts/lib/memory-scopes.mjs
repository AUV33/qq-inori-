// memory-scopes.mjs · 记忆作用域的单一发现逻辑（评测/影子脚本共用）。
//
// 干什么：从 data/memory/ 里实际存在的 `memory*.jsonl` 动态生成 scope 列表。
// 为什么：旧实现在 eval-memory-golden.mjs / memory-score-shadow.mjs 里各写死一份真实群号
//         （此处不复述具体数字，避免再次触发隐私扫描），既让 CI 红灯，也让新群/归档群永远测不到。
// 输入输出：discoverMemoryScopes(memDir) → [{name,file,cache}]，按文件名排序（确定性）。
// 失败模式：目录不存在/不可读 → 只返回 private 一项，不抛错。
// 不做什么：不读记忆内容、不写文件、不引入任何真实标识。

import fs from 'node:fs';
import path from 'node:path';

export function discoverMemoryScopes(memDir) {
  const scopes = [{ name: 'private', file: 'memory.jsonl', cache: 'embeddings.json' }];
  let names = [];
  try { names = fs.readdirSync(memDir).filter((n) => /^memory-.+\.jsonl$/.test(n)).sort(); } catch { return scopes; }
  for (const file of names) {
    const stem = file.slice(0, -'.jsonl'.length);        // memory-group_xxx
    scopes.push({
      name: stem,
      file,
      cache: `embeddings-${stem.slice('memory-'.length)}.json`,
    });
  }
  return scopes;
}

/** 两个脚本都用 data/memory 根；单独导出以便测试注入临时目录。 */
export function defaultScopes(root) {
  return discoverMemoryScopes(path.join(root, 'data', 'memory'));
}
