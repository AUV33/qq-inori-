// [SPLIT 阶段4] 从 console-server.mjs 巨型 ladder 迁出的黑话（slang）管理路由组（2026-11 拆分）。
//
// 契约：导出 slangRoutes 数组，元素为 { method, path, handle(ctx) }。
// ctx = { req, res, url, sendJson, readBody, deps, auth } —— deps 即原 __deps。
// 迁移原则：分支体逐字搬移，只把 `__deps.` → `deps.`；不改判断顺序、不改错误处理。
//
// 注意：带 :id 的参数路由（PATCH/POST confirm|reject、DELETE /api/slang/:id）依赖正则 slangMatch，
// 而 createConsoleRouter 只做精确匹配，故仍留在 console-server.mjs 的 legacy ladder 里。
// [PROTO-SANITIZE] 展开外部请求体前递归剔除 __proto__/constructor/prototype，阻断原型污染。
function stripDangerousKeys(value) {
  if (Array.isArray(value)) return value.map(stripDangerousKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stripDangerousKeys(v);
    }
    return out;
  }
  return value;
}

export const slangRoutes = [
  {
    method: 'GET',
    path: '/api/slang',
    handle: async ({ url, sendJson, deps }) => {
      const status = url.searchParams.get('status') || '';
      const list = status ? deps.slangEntries.filter((e) => e.status === status) : deps.slangEntries;
      sendJson({ entries: list, config: deps.cfg.slang });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const content = String(body.content ?? '').trim();
      if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
      if (deps.slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
      const entry = deps.createSlangEntry({
        content,
        meaning: String(body.meaning ?? '').trim(),
        usage: String(body.usage ?? '').trim(),
        example: String(body.example ?? '').trim(),
        risk: String(body.risk ?? '').trim(),
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        status: body.status === deps.SLANG_STATUS.CANDIDATE ? deps.SLANG_STATUS.CANDIDATE : deps.SLANG_STATUS.CONFIRMED,
        source: 'manual',
        evidence: Array.isArray(body.evidence) ? body.evidence : []
      });
      deps.slangEntries.push(entry);
      deps.saveSlangStore();
      deps.log(`控制台：新增黑话「${content}」`);
      sendJson({ ok: true, entry });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/clear',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const status = String(body.status ?? '').trim();
      if (status && ![deps.SLANG_STATUS.CANDIDATE, deps.SLANG_STATUS.CONFIRMED, deps.SLANG_STATUS.REJECTED].includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
        return;
      }
      let removedCount = 0;
      if (status) {
        removedCount = deps.slangEntries.filter((e) => e.status === status).length;
        deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      } else {
        removedCount = deps.slangEntries.length;
        deps.slangEntries = [];
        // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
        deps.slangWindows.clear();
        deps.slangExtractionCooldowns.clear();
        deps.slangSubmitTimes.clear();
        deps.slangResearchingIds.clear();
      }
      deps.saveSlangStore();
      deps.log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
      sendJson({ ok: true, removedCount });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/batch-delete',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const status = String(body.status ?? '').trim();
      if (ids.length) {
        const idSet = new Set(ids);
        const before = deps.slangEntries.length;
        deps.slangEntries = deps.slangEntries.filter((e) => !idSet.has(e.id));
        const removedCount = before - deps.slangEntries.length;
        if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
        deps.saveSlangStore();
        deps.log(`控制台：批量删除黑话 ${removedCount} 条`);
        sendJson({ ok: true, removedCount });
        return;
      }
      if (status && ![deps.SLANG_STATUS.CANDIDATE, deps.SLANG_STATUS.CONFIRMED, deps.SLANG_STATUS.REJECTED].includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
        return;
      }
      if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
      const removedCount = deps.slangEntries.filter((e) => e.status === status).length;
      deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      deps.saveSlangStore();
      deps.log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
      sendJson({ ok: true, removedCount });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/batch-confirm',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
      let confirmedCount = 0;
      let skippedCount = 0;
      const skipped = [];
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
        const entry = deps.slangEntries[idx];
        if (entry.status !== deps.SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
        if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
        entry.status = deps.SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        confirmedCount++;
      }
      if (confirmedCount) deps.saveSlangStore();
      deps.log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
      sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/batch-reject',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
      let rejectedCount = 0;
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) continue;
        const entry = deps.slangEntries[idx];
        if (entry.status === deps.SLANG_STATUS.REJECTED) continue;
        entry.status = deps.SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        rejectedCount++;
      }
      if (rejectedCount) deps.saveSlangStore();
      deps.log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
      sendJson({ ok: true, rejectedCount });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/extract',
    handle: async ({ sendJson, readBody, deps }) => {
      if (deps.cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (key && deps.slangWindows.has(key)) {
        deps.queueSlangTask(() => deps.runSlangExtraction(key));
        sendJson({ ok: true, key });
      } else {
        const firstKey = deps.slangWindows.keys().next().value;
        if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
        deps.queueSlangTask(() => deps.runSlangExtraction(firstKey));
        sendJson({ ok: true, key: firstKey });
      }
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/research',
    handle: async ({ sendJson, readBody, deps }) => {
      if (deps.cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const candidates = ids.length
        ? deps.slangEntries.filter((e) => ids.includes(e.id) && e.status === deps.SLANG_STATUS.CANDIDATE)
        : deps.slangEntries.filter((e) => e.status === deps.SLANG_STATUS.CANDIDATE);
      if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
      deps.queueSlangTask(() => deps.runSlangResearch(candidates));
      sendJson({ ok: true, count: candidates.length });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/slang/config',
    handle: async ({ sendJson, readBody, deps }) => {
      const body = await readBody();
      const oldPreset = deps.cfg.slang?.learnerPreset;
      const oldWorkspaceTitle = deps.cfg.slang?.workspaceTitle;
      const configFile = deps.path.join(deps.ROOT, 'config.json');
      const file = deps.readConfigObject(configFile);
      // [PROTO-SANITIZE] 展开请求体前剔除危险键。
      const merged = { ...(file.slang ?? {}), ...stripDangerousKeys(body) };
      if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
      else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
      if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
      if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
      if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
      if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
      if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
      if (body.inferenceThresholds !== undefined) {
        const raw = Array.isArray(body.inferenceThresholds)
          ? body.inferenceThresholds
          : String(body.inferenceThresholds).split(/[,，\s]+/);
        merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
        if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
      }
      file.slang = merged;
      deps.atomicWriteJson(configFile, file);
      deps.cfg.slang = { ...deps.cfg.slang, ...merged };
      if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
        deps.invalidateSlangLearnerSession();
        deps.log('黑话学习 preset 已变更，已重置学习会话');
      } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
        deps.invalidateSlangLearnerSession();
        deps.log('黑话学习工作区名已变更，已重置学习会话');
      }
      deps.log('控制台：黑话系统配置已更新');
      sendJson({ ok: true, config: deps.cfg.slang });
      return;
    },
  },
];
