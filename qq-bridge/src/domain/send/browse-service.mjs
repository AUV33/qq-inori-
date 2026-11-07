// 冲浪沉淀：把 pending 的浏览记录合成一条 browse 记忆（空内容只记 missed）。
//
// 从 app.mjs 的 main() 搬出（P3-RW-56，2026-11-01）。browseStore/browseSave 仍由 app 持有，
// 通过 getter/setter 读写同一实例。
/**
 * @param {object} ctx
 */
export function createBrowseService(ctx) {
  const {
    log, getBrowseStore, setBrowseStore, browseSave, pendingBrowse, hasContent,
    markBrowseOutcome, renderBrowseDigest, loadEntries, MEMORY_FILE, appendJsonl,
  } = ctx;
  function sedimentBrowseIfAny() {
    try {
      const pend = pendingBrowse(getBrowseStore());
      if (!pend.length) return;
      // [ACQ-GATE] 先分「真的取到内容」和「只发起了请求」：空 head 永远不沉淀，只记 missed。
      const withContent = pend.filter(hasContent);
      const emptyCount = pend.length - withContent.length;
      if (emptyCount) {
        const r = markBrowseOutcome(getBrowseStore(), pend.filter((e) => !hasContent(e)), Date.now());
        setBrowseStore(r.store);
        browseSave();
        log(`[browse] 没取到内容 ${r.missed} 条：记 missed，不写记忆`);
      }
      if (withContent.length < 2) return;
      const text = renderBrowseDigest(withContent, { maxItems: 8 });
      if (!text) return;
      // [NO-DUP] 同一段浏览不重复写（最近 12 条记忆里有同文就跳过）；跳过也要标已处理，避免永远 pending
      let duplicate = false;
      try {
        const recentMem = loadEntries(MEMORY_FILE).slice(-12);
        duplicate = recentMem.some((e) => e && e.text === text);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'browse-service.mjs:3155'); }
      if (!duplicate) {
        const d = new Date();
        const day = d.toLocaleDateString('sv-SE');
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        appendJsonl(MEMORY_FILE, { day, time: `${day} ${hm}`, kind: 'browse', text, src: 'auto', importance: 2 });
      }
      const r = markBrowseOutcome(getBrowseStore(), withContent, Date.now());
      setBrowseStore(r.store);
      browseSave();
      log(`[browse] 冲浪沉淀：${r.sedimented} 条有内容 → 记忆${duplicate ? '（同文已存在，跳过写入）' : ''}`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'browse-service.mjs:3163'); }
  }

  return { sedimentBrowseIfAny };
}
