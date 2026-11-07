// inori-memory-maint.js · 记忆维护单一流水线（重构：把桥接里的散装维护逻辑收拢到这里）
//
// 一条流水线，顺序固定，避免两套规则抢同一个文件：
//   ① 旧 group-digest → 一条 group-compact（窗口外、超出保留数）
//   ② fact 超上限 → 最旧的事实进 _archive（仍可检索）
//   ③ >archiveAfterDays 且非重要的旧条目 → _archive（仍可检索）
//   ④ 近重复事实/印象 → 合并成一条（consolidate，带 mergedFrom 溯源）
// 处理对象：私人 memory.jsonl + 各群 memory-group_*.jsonl（私人与群记忆同样巩固/遗忘，R5）。
// 只做文件维护，不做检索、不调用模型；调用方负责定时（桥接 6h + 启动一次）。
//
// [ATOMIC-2026-11-03] 两处裸 writeFileSync 改为 withFileLock + writeTextAtomic：
//   维护线程重写主文件时，热路径的 append 不会丢；进程被杀时文件不会只剩半截。
//   锁失败（另一进程长期持有）时记 errors 并保留原文件，绝不退化成非原子写。
import fs from 'node:fs';
import path from 'node:path';
import { planCompaction, parseEntries, serializeEntries, splitFactsForCap } from './inori-compact.js';
import { archiveOld } from '../memory/memory-retrieve.js';
import { withFileLock, writeTextAtomic } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { partitionForRetention, DEFAULT_MAX_ENTRIES } from '../memory/memory-retention.mjs';
import { consolidateWithSemantic } from '../memory/memory-consolidate.mjs';

export const DEFAULTS = {
  afterDays: 3,        // 早于 N 天的 digest 才参与压缩
  keepRecentDigests: 20, // 每个群永远保留最近 N 条 digest 原文
  maxChars: 600,       // 压缩摘要正文上限
  factCap: 300,        // 每个群 fact 上限
  archiveAfterDays: 90, // 超过 N 天且非重要的条目归档
  maxEntries: DEFAULT_MAX_ENTRIES, // 单文件硬上限：超了按保留分移出（归档可恢复）
  consolidate: true, // 近重复合并写盘开关（R5 巩固默认开；保守阈值 0.85，只合并不删除）
};

/**
 * [ARCHIVE-COMPACT] 归档库压缩：_archive 里超过 maxLines 的文件，只留最近 keep 行，
 * 更旧的合并成一条 archive-compact 摘要（原文不再保留，归档前先备份 .bak-<ts>）。
 */
export function compactArchiveDir(dir, { maxLines = 600, keep = 400 } = {}) {
  const report = { files: 0, compacted: 0, errors: [] };
  const archDir = path.join(dir, '_archive');
  let names = [];
  try { names = fs.readdirSync(archDir).filter((f) => /^memory.*\.jsonl$/.test(f)); } catch { return report; }
  for (const name of names) {
    const file = path.join(archDir, name);
    const outcome = withFileLock(file, () => {
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      if (rows.length <= maxLines) return { skipped: true };
      const keepRows = rows.slice(-keep);
      const dropped = rows.length - keep;
      const first = (() => { try { return JSON.parse(rows[0]).day || ''; } catch { return ''; } })();
      const last = (() => { try { return JSON.parse(keepRows[0]).day || ''; } catch { return ''; } })();
      try { fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch (error) { globalThis.__ignoredCatch?.(error, 'inori-memory-maint.js:43'); }
      const d = new Date();
      const day = d.toLocaleDateString('sv-SE');
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const summary = { day, time: day + ' ' + hm, kind: 'archive-compact', text: '【归档压缩】' + dropped + ' 条更旧条目（' + first + '~' + last + '）已压缩', importance: 2, src: 'auto' };
      const wrote = writeTextAtomic(file, keepRows.join('\n') + '\n' + JSON.stringify(summary) + '\n', { source: 'memory-maint/archive-compact' });
      if (!wrote || wrote.ok === false) throw new Error(wrote?.error || 'atomic write failed');
      return { compacted: dropped };
    }, { source: 'memory-maint/archive-compact' });
    if (!outcome || outcome.ok === false) { report.errors.push(name + ': ' + (outcome?.error || 'lock failed')); continue; }
    if (outcome.skipped) continue;
    report.files += 1;
    report.compacted += outcome.compacted || 0;
  }
  return report;
}

export function maintainMemoryDir(dir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const report = { dir, files: 0, compacted: 0, factsArchived: 0, archived: 0, errors: [] };
  let names = [];
  try {
    // 私人核心记忆 memory.jsonl 与群记忆 memory-group_*.jsonl 同样参与巩固/遗忘（R5）。
    names = fs.readdirSync(dir).filter((f) => f === 'memory.jsonl' || /^memory-group_.*\.jsonl$/.test(f));
  } catch (e) {
    report.errors.push(String(e?.message ?? e));
    return report;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const outcome = withFileLock(file, () => {
      let entries = parseEntries(fs.readFileSync(file, 'utf8'));
      // [CONSOLIDATE] 近重复合并：o.consolidate=true 才真正合并写盘（默认开）。
      let consolidatable = 0;
      let consolidated = 0;
      try {
        const c = consolidateWithSemantic(entries, { threshold: Number(o.consolidateThreshold) || 0.85, semantic: o.semanticCompress === true });
        consolidatable = c.mergedCount;
        if (o.consolidate === true && c.mergedCount > 0) {
          entries = c.keep;
          consolidated = c.mergedCount;
        }
      } catch { /* 合并失败不影响维护 */ }
      const plan = planCompaction(entries, {
        now: Number(opts.now) || Date.now(),
        afterDays: o.afterDays,
        keepRecent: o.keepRecentDigests,
        maxChars: o.maxChars,
      });
      const split = splitFactsForCap(plan.compacted ? plan.entries : entries, { maxFacts: o.factCap });
      const maxEntries = Math.max(1, Number(o.maxEntries) || DEFAULT_MAX_ENTRIES);
      const overCap = Array.isArray(split.keep) && split.keep.length > maxEntries;
      if (!plan.compacted && !split.overflow.length && !overCap && !consolidated) return { skipped: true, consolidatable, consolidated };
      try { fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch (error) { globalThis.__ignoredCatch?.(error, 'inori-memory-maint.js:79'); }
      if (split.overflow.length) {
        try {
          fs.mkdirSync(path.join(dir, '_archive'), { recursive: true });
          fs.appendFileSync(path.join(dir, '_archive', name), split.overflow.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        } catch (e) { throw new Error('归档 fact 失败 ' + (e?.message ?? e)); }
      }
      // [RETENTION] 硬上限：超过 maxEntries 时按“重要度×时近×被回忆”移出最低分（归档可恢复）。
      // 现状记忆文件远小于上限，机制先就位；保护条目（她自己写的/重要≥4/fact/pinned）永不归档。
      let finalEntries = split.keep;
      let retentionArchived = 0;
      if (Array.isArray(finalEntries) && finalEntries.length > maxEntries) {
        const rp = partitionForRetention(finalEntries, { now: Number(opts.now) || Date.now(), maxEntries });
        if (rp.archive.length) {
          fs.mkdirSync(path.join(dir, '_archive'), { recursive: true });
          fs.appendFileSync(path.join(dir, '_archive', name), rp.archive.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
          finalEntries = rp.keep;
          retentionArchived = rp.archive.length;
        }
      }
      const wrote = writeTextAtomic(file, serializeEntries(finalEntries), { source: 'memory-maint' });
      if (!wrote || wrote.ok === false) throw new Error(wrote?.error || 'atomic write failed');
      return { compacted: plan.compacted, factsArchived: split.overflow.length, retentionArchived, consolidatable, consolidated };
    }, { source: 'memory-maint' });
    if (!outcome || outcome.ok === false) { report.errors.push(name + ': ' + (outcome?.error || 'lock failed')); continue; }
    report.consolidatable = (report.consolidatable || 0) + (outcome.consolidatable || 0);
    report.consolidated = (report.consolidated || 0) + (outcome.consolidated || 0);
    if (outcome.skipped) continue;
    report.files += 1;
    report.compacted += outcome.compacted || 0;
    report.factsArchived += outcome.factsArchived || 0;
    report.retentionArchived = (report.retentionArchived || 0) + (outcome.retentionArchived || 0);
  }
  try {
    const r = archiveOld(dir, { maxAgeDays: o.archiveAfterDays });
    report.archived = Number(r?.moved) || 0;
  } catch (e) { report.errors.push('archive: ' + (e?.message ?? e)); }
  // [ARCHIVE-COMPACT] 归档库本身也会膨胀：超过阈值的归档文件压缩成一条摘要
  try {
    const c = compactArchiveDir(dir, { maxLines: Number(opts.archiveMaxLines) || 600, keep: Number(opts.archiveKeep) || 400 });
    report.archiveCompacted = c.compacted;
  } catch (e) { report.errors.push('archive-compact: ' + (e?.message ?? e)); }
  return report;
}
