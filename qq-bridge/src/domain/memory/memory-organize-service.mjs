// 记忆库机械整理：旧滚动摘要搬 _archive、落 index.json（不删、不判断内容）。
//
// 从 app.mjs 的 main() 搬出（P3-RW-51，2026-11-01）。目录/索引路径随模块；
// 只做文件搬运与计数，不改记忆内容。
// [ATOMIC-RETRY] 2026-11-03：tmp→正式文件的 rename 走带 EPERM/EBUSY 重试的实现
// （Windows 上杀软/索引占用会让裸 renameSync 直接失败，旧文件就停在被替换前）。
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';
/**
 * @param {object} ctx
 */
export function createMemoryOrganize(ctx) {
  const { fs, path, cfg, MEM_DIR, log, planOrganize, atomicWriteJson } = ctx;
  const MEMORY_DIR = cfg.socialV2?.memoryInject?.dir || cfg.socialV2?.memory?.dir || MEM_DIR;
  const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, 'index.json');
  function organizeMemoryFiles({ apply = false, dir = MEMORY_DIR } = {}) {
    const out = { at: new Date().toISOString(), dir, files: {}, archived: 0, errors: [] };
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')); } catch (e) { out.errors.push(String(e?.message ?? e)); return out; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const plan = planOrganize(rows);
        out.files[name] = { total: plan.total, plan: plan.summary, index: plan.index };
        if (!apply || !plan.archiveIndexes.length) continue;
        const archDir = path.join(dir, '_archive');
        fs.mkdirSync(archDir, { recursive: true });
        const archived = plan.archiveIndexes.map((i) => ({ ...rows[i], _archived: true, _archivedAt: out.at }));
        fs.appendFileSync(path.join(archDir, name), archived.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        const drop = new Set(plan.archiveIndexes);
        const kept = rows.filter((_, i) => !drop.has(i));
        const bak = `${file}.bak-org-${Date.now()}`;
        fs.copyFileSync(file, bak);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, kept.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        renameWithRetry(tmp, file);
        out.archived += archived.length;
        log(`[mem-organize] ${name} 旧快照归档 ${archived.length} 条（剩 ${kept.length}），备份 ${path.basename(bak)}`);
      } catch (e) { out.errors.push(`${name}: ${e?.message ?? e}`); }
    }
    try {
      const index = { at: out.at, files: Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k, v.index])), summary: Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k, v.plan])) };
      const itmp = `${MEMORY_INDEX_FILE}.${process.pid}.tmp`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(itmp, JSON.stringify(index, null, 2), 'utf8');
      renameWithRetry(itmp, MEMORY_INDEX_FILE);
    } catch (e) { out.errors.push(`index: ${e?.message ?? e}`); }
    const brief = Object.entries(out.files).map(([k, v]) => `${k}(${v.total}条,旧快照${v.plan.archive})`).join(' ');
    log(`[mem-organize] 整理完成${apply ? '（已归档）' : '（dry-run）'}：${brief}`);
    return out;
  }
  setTimeout(() => { try { organizeMemoryFiles({ apply: true }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'memory-organize-service.mjs:5992'); } }, 45000).unref?.();
  const memOrganizeTimer = setInterval(() => { try { organizeMemoryFiles({ apply: true }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'memory-organize-service.mjs:5993'); } }, 6 * 3600 * 1000);
  memOrganizeTimer.unref?.();
  return { organizeMemoryFiles };
}
