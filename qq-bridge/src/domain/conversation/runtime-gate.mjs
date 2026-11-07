// runtime-gate.mjs · 注意门（gate）运行时服务（从 app.mjs 拆出）
//
// 纯判定函数仍在 inori-gate.js；这里只放“巡检/嵌入服务/门循环”的运行态。
// 依赖由 app 注入；gateSessions/gateCollectors/gateBatches 暴露给 mux-bus。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GATE_DEFAULTS, anchorSet, embedChunks, maxAnchorCosine, effectiveGateThreshold, parseGateSensitivityOverride, gatePayloadText, parseGateReply, shapeMessages, shouldBatch } from '../leaves/inori-gate.js';
import { load as loadGoals } from '../leaves/inori-goals.js';
import { openLoops as openCuriosityLoops } from '../leaves/inori-curiosity.js';
import { withFileLock, writeTextAtomic } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export function createGateService(deps) {
  const {
    cfgRef, log, api, STATE_DIR, getSocialV2State, saveSocialV2State,
    getSelfNickname, readRoleState, scheduleWakeV2, getSocialV2Map, local3bAlive,
    completeLocal3b, deliverToIsolated, isolatedSessions, claimEmbedSpawn,
    resetClaim, fetchImpl = globalThis.fetch,
    // [C1] 内在偏置：SelfState/Belief → 注意门阈值的 ±0.04 微调（缺省不生效）
    getMindBias = null,
  } = deps;
  const fetchFn = fetchImpl;
  const wait = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
  const AbortSignal = globalThis.AbortSignal;
  const gateEmbedCfg = () => cfgRef?.gate ?? {};
  const gateSessions = new Set();
  const gateCollectors = new Map();
  const gateBatches = new Map();
  const gateSensPath = () => path.join(STATE_DIR, 'gate-sensitivity.json');
  const gateLogPath = () => path.join(STATE_DIR, 'attention-gate.log');
  const gateAnchorCache = new Map();

  // ---- 以下为原 app.mjs 的 gate 块（只把 cfg 改成 cfgRef，把 embedSpawnClaimAt=0 改成 resetClaim）----
  function gateEmbedBase() {
    const c = gateEmbedCfg();
    const base = String(c.embedBase ?? '').trim().replace(/\/+$/, '');
    return base || `http://127.0.0.1:${Number(c.embedPort ?? 8790)}`;
  }
  async function gateEmbedAlive() {
    try {
      const r = await fetchFn(`${gateEmbedBase()}/v1/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: String(gateEmbedCfg().embedModelName ?? 'bge-m3'), input: ['ping'] }),
        signal: AbortSignal.timeout(4000),
      });
      return r.status === 200;
    } catch { return false; }
  }
  let gateEmbedProc = null;
  async function gateEmbedStart() {
    // 审计/配置检查不拉起真实 llama-server，避免测试占端口/吃显存。
    if (process.env.BRIDGE_AUDIT === '1' || process.env.BRIDGE_CONFIG_CHECK === '1') return;
    const c = gateEmbedCfg();
    // 路径不再写死作者机器：配置（embedExe/embedModel）→ 环境变量（INORI_EMBED_EXE/INORI_EMBED_MODEL）→ 空。
    // 为空时 existsSync 检查会提示「embedding 服务不可用」并跳过，而非尝试作者路径。
    const exe = String(c.embedExe || process.env.INORI_EMBED_EXE || '');
    const model = String(c.embedModel || process.env.INORI_EMBED_MODEL || '');
    if (!fs.existsSync(exe) || !fs.existsSync(model)) {
      log(`[gate] embedding 服务不可用（exe 或模型文件缺失：${exe} / ${model}）`);
      return;
    }
    if (gateEmbedProc && gateEmbedProc.exitCode === null) return;
    for (let i = 0; i < 10 && !(await gateEmbedAlive()); i++) await wait(3000);
    if (await gateEmbedAlive()) { log('[gate] 共享 embedding 服务已在线（外部实例已就绪）'); return; }
    if (!claimEmbedSpawn()) { log('[gate] 90 秒内已有人拉过 embedding 服务，本次跳过'); return; }
    const port = Number(c.embedPort ?? 8790);
    // [EMBED-MEM] 上下文/批次可配：bge-m3 的 KV cache 随 -c 线性长，默认 8192 在 16GB 机器上
    // 实测占 2.3GB RSS，是常驻进程里最大的一块。默认值保持不变，配置可降到 2048/512。
    const ctx = Math.max(512, Number(c.embedCtx) || 8192);
    const ub = Math.max(128, Number(c.embedUb) || 2048);
    log(`[gate] 拉起共享 embedding 服务（bge-m3，127.0.0.1:${port}，ctx=${ctx} ub=${ub}；与 9-启动嵌入服务.bat / 本地记忆检索共用）...`);
    const proc = spawn(exe, ['-m', model, '--embedding', '--pooling', 'cls', '-c', String(ctx), '-ub', String(ub), '--host', '127.0.0.1', '--port', String(port), '-ngl', '99', '--no-webui'], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
    gateEmbedProc = proc;
    proc.on('exit', (code) => {
      if (gateEmbedProc === proc) { gateEmbedProc = null; log(`[gate] embedding 服务进程退出（code=${code}），巡检将按规则重新拉起（若外部实例已先拉起则复用）`); }
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000 && !(await gateEmbedAlive())) await wait(2000);
    if (await gateEmbedAlive()) log('[gate] 共享 embedding 服务就绪（粗筛可用）');
    else log('[gate] embedding 服务 3 分钟未就绪：门粗筛暂停，巡检（120s）继续探测');
  }
  async function gateEmbedTexts(texts) {
    const c = gateEmbedCfg(); const base = gateEmbedBase(); const model = String(c.embedModelName ?? 'bge-m3');
    const out = new Array((texts ?? []).length).fill(null); let off = 0;
    for (const chunk of embedChunks(texts, { batch: Number(c.embedBatch ?? 16) })) {
      const r = await fetchFn(`${base}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: chunk }), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
      const data = await r.json();
      (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).forEach((d, i) => { out[off + i] = d.embedding; });
      off += chunk.length;
    }
    return out;
  }
  let gateEmbedFails = 0;
  let gateEmbedRestarting = false;
  setInterval(async () => {
    try {
      if (gateEmbedCfg().enabled === false) return;
      if (gateEmbedRestarting) return;
      if (await gateEmbedAlive()) { gateEmbedFails = 0; return; }
      gateEmbedFails += 1;
      if (gateEmbedFails < 3) { log(`[gate] embedding 探测失败 ${gateEmbedFails}/3（连续 3 次仍失败就重拉）`); return; }
      gateEmbedFails = 0; gateEmbedRestarting = true;
      try {
        let ownHung = false;
        if (gateEmbedProc && gateEmbedProc.exitCode === null) {
          log('[gate] embedding 连续 3 次无响应：杀掉挂住的子进程后重拉');
          try { gateEmbedProc.kill('SIGKILL'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-gate.mjs:101'); }
          gateEmbedProc = null; ownHung = true; await wait(1500);
        }
        if (ownHung) resetClaim();
        await gateEmbedStart();
      } finally { gateEmbedRestarting = false; }
    } catch (error) { log(`[gate] embedding 巡检异常: ${error?.message ?? error}`); }
  }, 120_000).unref?.();
  if (gateEmbedCfg().enabled !== false) {
    void (async () => {
      try { if (await gateEmbedAlive()) log('[gate] 共享 embedding 服务在线（复用，不重开）'); else await gateEmbedStart(); }
      catch (error) { log(`[gate] 启动探测异常: ${error?.message ?? error}`); }
    })();
  }

  function gateAnchors(key) {
    try {
      const st = getSocialV2State(key);
      const goalTitles = loadGoals(cfgRef?.socialV2?.goals?.file).filter((g) => g.status === 'active').slice(0, 4).map((g) => String(g.title ?? g.text ?? '')).filter(Boolean);
      let loopTexts = [];
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'curiosity.json'), 'utf8'));
        loopTexts = openCuriosityLoops(cur).slice(0, 4).map((l) => String(l.text ?? '')).filter(Boolean);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-gate.mjs:124'); }
      const anchors = anchorSet({ selfName: String(getSelfNickname?.() ?? '').trim() || '', keywords: st.wakeConfig?.triggers?.keywords ?? [], goalTitles, openLoops: loopTexts });
      const hash = JSON.stringify(anchors);
      const hit = gateAnchorCache.get(key);
      if (hit && hit.hash === hash) return hit;
      gateAnchorCache.set(key, { hash, anchors });
      return gateAnchorCache.get(key);
    } catch { return { hash: '', anchors: [] }; }
  }
  function gateAgentName(key) {
    let role = '';
    try { role = String(readRoleState()?.role ?? ''); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-gate.mjs:135'); }
    const nick = String(getSelfNickname?.() ?? '').trim();
    const variants = new Set([role, nick, nick ? nick.toLowerCase() : ''].filter(Boolean));
    return variants.size ? `[${[...variants].join('/')}]` : '(未命名 agent)';
  }
  function markGateSeen(key, msgs) {
    try {
      const gSt = getSocialV2State(key);
      const maxSeq = Math.max(Number(gSt.gateHighSeq) || 0, ...(Array.isArray(msgs) ? msgs : []).map((m) => Number(m?.seq) || 0));
      if (maxSeq > (Number(gSt.gateHighSeq) || 0)) { gSt.gateHighSeq = maxSeq; saveSocialV2State(); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-gate.mjs:145'); }
  }
  function appendGateLog(row) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(gateLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n', 'utf8');
      const cap = Number(gateEmbedCfg().keepLogLines ?? 400);
      const all = fs.readFileSync(gateLogPath(), 'utf8').trimEnd().split('\n').filter(Boolean);
      if (all.length > cap) withFileLock(gateLogPath(), () => { writeTextAtomic(gateLogPath(), all.slice(-cap).join('\n') + '\n', { source: 'bridge/gate-log' }); return { ok: true }; }, { source: 'bridge/gate-log' });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-gate.mjs:154'); }
  }
  function applyGateHits({ key, msgs, hits, raw, source = 'flash' }) {
    try {
      appendGateLog({ key, stage: 2, completed: true, hits: hits.length, source, raw: String(raw ?? '').slice(0, 240) });
      markGateSeen(key, msgs);
      if (!hits.length) return;
      const gSt = getSocialV2State(key);
      gSt.gateLastHits = { at: Date.now(), hits, msgs };
      saveSocialV2State();
      log(`[gate] ${key} 精判命中 ${hits.length} 条（${hits.map((h) => `${h.why || '#' + h.i}`).join('；').slice(0, 90)}，来源 ${source}）→ 唤醒她`);
      if (gSt.wakeConfig?.infinite) { appendGateLog({ key, stage: 3, skipped: 'infinite-dive' }); log(`[gate] ${key} 她设了无限潜水：门命中已记录（gateLastHits），不强制唤醒（尊重她的决定）`); return; }
      scheduleWakeV2(key, 'topicMention');
    } catch (error) { log(`[gate] 命中处理失败（已忽略）: ${error?.message ?? error}`); }
  }
  let gateSensCache = { mtimeMs: 0, raw: null, valid: true };
  function loadGateSensOverride() {
    let st;
    try { st = fs.statSync(gateSensPath()); } catch { if (gateSensCache.raw !== null) log('[gate-tune] 覆盖已移除，回 config 基线'); gateSensCache = { mtimeMs: 0, raw: null, valid: true }; return null; }
    if (st.mtimeMs === gateSensCache.mtimeMs) return gateSensCache.raw;
    let raw = null;
    try { const text = fs.readFileSync(gateSensPath(), 'utf8'); raw = parseGateSensitivityOverride(text); } catch { raw = null; }
    gateSensCache = { mtimeMs: st.mtimeMs, raw, valid: raw !== null };
    if (raw === null && gateSensCache.valid === false) log('[gate-tune] 覆盖文件解析失败，按无覆盖处理（回 config 基线）');
    return raw;
  }
  async function gateLoopTick() {
    const c = gateEmbedCfg();
    if (c.enabled === false) return;
    for (const [key, st] of (getSocialV2Map?.()?.conversations ?? new Map())) {
      if (!String(key).startsWith('group:')) continue;
      try {
        const unread = Array.isArray(st.unread) ? st.unread : [];
        const hiSeq = Number(st.gateHighSeq ?? 0);
        const pending = unread.filter((m) => m && !m.isSelf && Number(m.seq) > hiSeq);
        if (!shouldBatch({ pending: pending.length, lastGateAt: Number(st.lastGateAt ?? 0), now: Date.now(), minPending: Number(c.minPending ?? GATE_DEFAULTS.minPending), intervalMs: Number(c.intervalMs ?? GATE_DEFAULTS.intervalMs) })) continue;
        st.lastGateAt = Date.now();
        const shaped = shapeMessages(pending, { batchMax: Number(c.batchMax ?? GATE_DEFAULTS.batchMax) });
        if (!shaped.length) continue;
        let cosBest = -1, hitAnchor = null;
        try {
          const { anchors } = gateAnchors(key);
          if (!anchors.length) throw new Error('锚点为空（昵称/关键词/目标全空？）');
          const [textVecs, anchorVecs] = await Promise.all([gateEmbedTexts(shaped.map((m) => m.text)), gateEmbedTexts(anchors)]);
          const named = anchors.map((t, i) => { const v = anchorVecs[i]; if (!Array.isArray(v)) return null; v.name = t; return v; }).filter(Boolean);
          const r = maxAnchorCosine(textVecs, named); cosBest = r.best; hitAnchor = r.anchor;
        } catch (error) { appendGateLog({ key, stage: 1, error: String(error?.message ?? error).slice(0, 120) }); continue; }
        const baseTheta = Number(c.cosThreshold ?? GATE_DEFAULTS.cosThreshold);
        const sensOverride = loadGateSensOverride();
        // [C1] 内在偏置：情绪/关系/未解之事只做 ±0.04 的微调，不主导判定；每轮都记日志。
        let mindBias = 0;
        let mindWhy = [];
        try {
          if (cfgRef?.gate?.mindBias !== false && typeof getMindBias === 'function') {
            const mb = getMindBias(key) || {};
            mindBias = Math.max(-0.04, Math.min(0.04, Number(mb.bias) || 0));
            mindWhy = Array.isArray(mb.reasons) ? mb.reasons.slice(0, 3) : [];
          }
        } catch { /* 偏置失败不影响门 */ }
        const thetaBase = effectiveGateThreshold(baseTheta, sensOverride?.cosThreshold);
        const theta = Math.max(0.05, Math.min(0.95, thetaBase + mindBias));
        const thetaSource = sensOverride?.cosThreshold != null ? (sensOverride.by || 'agent') : 'config';
        appendGateLog({ key, stage: 1, pending: shaped.length, cosBest: Number(cosBest.toFixed(4)), theta, thetaBase, thetaSource, mindBias, mindWhy, hitAnchor, pass: cosBest >= theta });
        if (cosBest < theta) { markGateSeen(key, shaped); continue; }
        const { anchors } = gateAnchors(key);
        const payload = gatePayloadText({ agentName: gateAgentName(key), anchors, messages: shaped });
        if (cfgRef?.socialV2?.gate?.local3bFirst !== false) {
          try {
            if (await local3bAlive?.(cfgRef)) {
              const t0 = Date.now();
              const rule = '你是唤醒判定的判官。只有当消息明确在叫她、直接问她、或明确在说她的事（提到她的名字/称呼/她做过的事）时才算命中；普通陈述、玩笑、闲聊一律不算。只输出 JSON：{"hits":[{"i":消息序号,"why":"10字内理由"}]}；没命中输出 {"hits":[]}。';
              const raw3b = await completeLocal3b?.(cfgRef, { prompt: `${rule}\n\n${payload}`, maxTokens: 300, temperature: 0, timeoutMs: Math.min(8000, Number(cfgRef?.socialV2?.gate?.local3bTimeoutMs) || 6000), log });
              const parsed = raw3b ? parseGateReply(raw3b) : null;
              const hasJson = Boolean(parsed && /\{\s*"hits"/.test(String(parsed.raw || '')));
              if (hasJson && parsed.hits.length) { applyGateHits({ key, msgs: shaped, hits: parsed.hits, raw: parsed.raw, source: `local3b(${Date.now() - t0}ms)` }); continue; }
              if (hasJson) log(`[gate] ${key} 本地 3B 无命中（${Date.now() - t0}ms）→ 交 flash 复核，避免漏消息`);
              else log(`[gate] ${key} 本地 3B 精判输出不可解析，回退 flash（原文 ${String(raw3b ?? '').replace(/\s+/g, ' ').slice(0, 80) || '空'}）`);
            }
          } catch (error) { log(`[gate] 本地 3B 精判失败，回退 flash: ${error?.message ?? error}`); }
        }
        const gateSid = isolatedSessions.get('gate');
        if (gateSid && gateSessions.has(gateSid)) { appendGateLog({ key, stage: 1, skipped: 'gate-busy', pending: shaped.length }); continue; }
        const res = await deliverToIsolated('gate', payload, { key: null, beforePrompt: (sid) => { gateBatches.set(sid, { key, msgs: shaped, ts: Date.now() }); api.events.follow(sid); gateSessions.add(sid); gateCollectors.delete(sid); } });
        if (!res?.ok || !res.sessionId) { if (res?.sessionId) { gateSessions.delete(res.sessionId); gateBatches.delete(res.sessionId); } appendGateLog({ key, stage: 2, error: String(res?.reason ?? res?.error ?? '投递失败').slice(0, 120) }); continue; }
        log(`[gate] ${key} 粗筛命中（cos=${cosBest.toFixed(3)} 锚="${hitAnchor ?? '?'}"，${shaped.length} 条）→ flash 精判中`);
      } catch (error) { log(`[gate] ${key} 循环异常: ${error?.message ?? error}`); }
    }
  }
  setInterval(() => { void gateLoopTick().catch((error) => log(`[gate] tick 异常: ${error?.message ?? error}`)); }, 30_000).unref?.();

  return {
    gateEmbedBase, gateEmbedAlive, gateEmbedStart, gateEmbedTexts, gateAnchors, gateAgentName, markGateSeen, appendGateLog, applyGateHits,
    loadGateSensOverride, gateLoopTick, gateSessions, gateCollectors, gateBatches,
  };
}
