// inori-embed-prune.js · 向量缓存清理（每周一次）
//
// 缓存格式：embeddings.json / embeddings-<scope>.json = { sha1(text): vector[] }
// 清理规则：只保留「当前记忆文件里还存在」的文本的向量；记忆文件不存在则删缓存文件。
// 不会碰 _archive/ 下的缓存（归档库自带一份，保持可检索）。
import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
import { embedKey } from '../../../../ai-companion-kit/packages/shared/embed-key.mjs';

function parseLines(raw) {
  return String(raw ?? '').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((x) => x && typeof x.text === 'string');
}

/** 清理一个记忆目录下的向量缓存。返回 {files, dropped, removedFiles, errors} */
export function pruneEmbeddingCaches(dir, _opts = {}) {
  const report = { files: 0, dropped: 0, removedFiles: 0, errors: [] };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^embeddings(-[^.]+)?\.json$/.test(f));
  } catch (e) { report.errors.push(String(e?.message ?? e)); return report; }
  for (const name of names) {
    const cacheFile = path.join(dir, name);
    const scope = name.replace(/^embeddings-?/, '').replace(/\.json$/, '');
    const memFile = path.join(dir, scope ? `memory-${scope}.jsonl` : 'memory.jsonl');
    try {
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { cache = {}; }
      let entries = [];
      try { entries = parseLines(fs.readFileSync(memFile, 'utf8')); } catch { entries = []; }
      if (!fs.existsSync(memFile)) {
        // 记忆文件已不存在（如群已从白名单移除）：缓存整份删掉
        fs.rmSync(cacheFile, { force: true });
        report.removedFiles += 1;
        continue;
      }
      const keep = new Set(entries.map((e) => embedKey(e.text)));
      const keys = Object.keys(cache);
      const stale = keys.filter((k) => !keep.has(k));
      if (!stale.length) continue;
      for (const k of stale) delete cache[k];
      try { atomicWriteJson(cacheFile, cache); } catch (e) { report.errors.push(`${name}: ${e?.message ?? e}`); continue; }
      report.files += 1;
      report.dropped += stale.length;
    } catch (e) { report.errors.push(`${name}: ${e?.message ?? e}`); }
  }
  return report;
}
