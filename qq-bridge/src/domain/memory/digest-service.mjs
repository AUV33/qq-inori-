import { readJsonl } from '../leaves/jsonl.mjs';
// 每日摘要与行为快照：把当天消息压成 day-digest、每小时把行为账写进记忆。
//
// 从 app.mjs 的 main() 搬出（P3-RW-23，2026-10-31）。只写记忆库，不发送、不改会话调度。
/**
 * @param {object} ctx
 */
export function createDigestService(ctx) {
  const {
    fs, cfg, state, getSocialV2State, filesForScope, MEM_DIR, alreadyDigested,
    digestDay, renderBehaviorLedger, sanitizeFact, appendJsonl, log,
  } = ctx;
  function readJsonlSafe(file) { return readJsonl(file, { fs }); }

  // [DIGEST] 把当天消息压成一条 day-digest，写进该会话的记忆库（事实层）：
  function writeDailyDigestV2() {
    try {
      if (cfg.socialV2?.digest?.enabled === false) return;
      const day = new Date().toLocaleDateString('sv-SE');
      let wrote = 0;
      for (const rawKey of Object.keys(state.sessions ?? {})) {
        // [DIGEST-LANE] owner lane（group:xxx#owner）与 base key 共用同一份记忆，跳过避免重复/无效 key
        if (String(rawKey).endsWith('#owner')) continue;
        const key = rawKey;
        const st = getSocialV2State(key);
        const msgs = (st.recentMessages ?? []).filter((m) => m && m.text);
        if (!msgs.length) continue;
        const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
        const existing = readJsonlSafe(P.file);
        if (alreadyDigested(existing, day)) continue;
        const d = digestDay(msgs, cfg.socialV2?.digest ?? {});
        if (!d.ok) { log(`[digest] ${key} 跳过（${d.reason}，${d.total} 条）`); continue; }
        // [MY-DAY] 当天摘要里带上行为账（手机/视频/经验/查词/接事/工具调用/行动），
        // 这样「我都干了什么」以后能靠记忆召回回答，而不是只在夜里反思时看一眼就没了。
        let ledgerText = '';
        try { ledgerText = renderBehaviorLedger({ day, now: new Date() }).replace(/^【[^】]*】\s*/, ''); } catch { ledgerText = ''; }
        const dayText = sanitizeFact(`${day} 这天：${d.text}`) + (ledgerText ? `\n我做的事：${ledgerText}` : '');
        const entry = { day, time: `${day} ${new Date().toTimeString().slice(0, 5)}`, kind: 'day-digest', text: dayText, theme: '日常', scope: P.scope };
        appendJsonl(P.file, entry, { source: 'bridge/daily-digest' });
        wrote++;
        log(`[digest] ${key} 写入当天摘要（${[...d.text].length} 字，取自 ${d.total} 条）`);
      }
      if (wrote) log(`[digest] 完成：${wrote} 个会话写了当天摘要`);
    } catch (error) {
      log(`[digest] 摘要失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  // [BEHAVIOR-MEM] 每小时把行为账写进记忆（带时间戳，kind=event，theme=我做的事）：
  // 「我都干了什么」不只是提示词里的一行——它要能被 memory_* 检索到、被她以后想起。
  // 同一小时只写一条（按 `YYYY-MM-DD HH` 去重），跨小时自动追加新快照。
  function writeBehaviorMemorySnapshot() {
    try {
      const now = new Date();
      const day = now.toLocaleDateString('sv-SE');
      const hh = String(now.getHours()).padStart(2, '0');
      const hhmm = `${hh}:${String(now.getMinutes()).padStart(2, '0')}`;
      const ledger = renderBehaviorLedger({ day, now });
      const body = String(ledger).replace(/^【[^】]*】\s*/, '').replace(/^\d{4}-\d{2}-\d{2}[：:]\s*/, '').trim();
      if (!body) return;
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, 'private');
      const stamp = `${day} ${hh}`;
      const recent = readJsonlSafe(P.file).slice(-300);
      if (recent.some((e) => e && e.kind === 'event' && String(e.theme || '') === '我做的事' && String(e.text || '').includes(stamp))) return;
      appendJsonl(P.file, {
        day,
        time: `${day} ${hhmm}`,
        kind: 'event',
        text: sanitizeFact(`${stamp} 点前我做了：${body}`),
        theme: '我做的事',
        scope: P.scope,
        importance: 2,
        src: 'bridge/behavior-snapshot',
      }, { source: 'bridge/behavior-snapshot' });
      log(`[behavior-mem] 写入 ${stamp} 行为快照`);
    } catch (error) {
      log(`[behavior-mem] 快照失败（已忽略）：${error?.message ?? error}`);
    }
  }

  return { readJsonlSafe, writeDailyDigestV2, writeBehaviorMemorySnapshot };
}
