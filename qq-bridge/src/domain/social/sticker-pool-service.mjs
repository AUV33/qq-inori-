// 表情池/打标：库里没有备注的表情用 vision 打标，自动收集候选入池。
//
// 从 app.mjs 的 main() 搬出（P3-RW-50，2026-11-01）。表情库/视觉/媒体全部注入；
// 模块只做打标、候选评估、池上限与注入行。
import crypto from 'node:crypto'; // [CRYPTO] 全局 crypto 是 WebCrypto（没有 createHash），md5 必须用 node:crypto
/**
 * @param {object} ctx
 */
export function createStickerPool(ctx) {
  const {
    fs, path, cfg, log, STATE_DIR, STICKER_FILE, atomicWriteJson, stickerService,
    loadStickerStore, saveStickerStore, getStickerImageData, applyStickerNote,
    stickerEnabled, syncStickerLibrary, fetchMediaData, visionAsk, mimeFromBuffer,
    safeFetchBuffer, parseStickerCaption, evaluateCaptionRetry, evaluateAutoCollect,
    stickerShortRefOf, activityTracker, getStickerSyncedAt, getStickerResyncAt, setStickerResyncAt,
    // [WIRING-FIX] bot 在 app.mjs 的 main() 里声明得比本工厂调用点晚（TDZ），
    // 直接注入会炸，所以传 getter，运行期（真正收藏时）再取。
    getBot,
    isDshReady, // [WIRING-FIX] 原来是 main() 里的裸变量 dshReady
    MAX_MEDIA_BYTES = 4 * 1024 * 1024, // [WIRING-FIX] 单条媒体字节上限（原来裸引用 app.mjs 常量）
  } = ctx;
  const STICKER_POOL_FILE = path.join(STATE_DIR, 'sticker-pool.json');
  const STICKER_POOL_CAP = 30;
  const STICKER_POOL_TTL_MS = 7 * 24 * 3600 * 1000;
  const STICKER_CAPTION_PROMPT = '这是一张 QQ 表情包（可能带字/梗）。只输出一行 JSON，不要别的文字：{"name":"2~10个字的情绪或动作（如 委屈巴巴 / 笑到打滚 / 摸摸头）","tags":["3~5个检索标签（如 安慰,可怜,无语）"],"note":"什么时候适合发（12~24字，用她的口吻，不写“这张图”）","meaning":"它表达什么意思/什么情绪（12~30字）","sticker":true,"collect":true}。若它不像表情包/梗图（普通照片、截图、风景），sticker 给 false；若不值得收进库（无明确含义、低价值、重复），collect 给 false。';
  async function captionStickerLibrary({ limit = 2, force = false } = {}) {
    if (!stickerEnabled()) return { ok: false, error: '表情包体系已关闭' };
    let list;
    try { list = loadStickerStore(STICKER_FILE); } catch (error) { return { ok: false, error: `表情库读不出：${error?.message ?? error}` }; }
    const todo = list.filter((e) => force || !String(e.desc || '').trim() || !String(e.localNote || '').trim()).slice(0, Math.max(1, Number(limit) || 2));
    if (!todo.length) return { ok: true, done: 0, note: '没有需要打标的（都有备注了）' };
    let done = 0; const failed = []; const receipts = [];
    for (const entry of todo) {
      try {
        const data = await getStickerImageData(entry.id);
        const fetched = await safeFetchBuffer(data.url, MAX_MEDIA_BYTES);
        const mimeType = mimeFromBuffer(fetched.buffer) || 'image/png';
        const text = await visionAsk([fetched.buffer.toString('base64')], STICKER_CAPTION_PROMPT, mimeType);
        const { name, tags, note } = parseStickerCaption(text);
        if (!name) { failed.push(entry.id); continue; }
        const upd = applyStickerNote(list, entry.id, { desc: name, tags, ...(note ? { note } : {}), source: 'ai', autoNoteAt: new Date().toISOString() });
        list = upd.entries;
        done += 1;
        receipts.push({ ref: stickerShortRefOf(entry), desc: name, tags });
        log(`[sticker-caption] 「${name}」${tags.length ? '[' + tags.join('/') + ']' : ''} ← ${String(entry.id).slice(0, 12)}`);
      } catch (error) { failed.push(entry.id); log(`[sticker-caption] 打标失败 ${String(entry.id).slice(0, 12)}: ${error?.message ?? error}`); }
    }
    if (done) {
      try { saveStickerStore(STICKER_FILE, list); stickerService.setEntries(list); } catch (error) { log(`[sticker-caption] 落盘失败: ${error?.message ?? error}`); }
    }
    return { ok: true, done, failed, receipts };
  }

  const STICKER_POOL_META_FILE = path.join(STATE_DIR, 'sticker-pool-meta.json');
  function poolMeta() { try { return JSON.parse(fs.readFileSync(STICKER_POOL_META_FILE, 'utf8')) || {}; } catch { return {}; } }
  function setPoolMeta(patch) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); const m = { ...poolMeta(), ...patch }; atomicWriteJson(STICKER_POOL_META_FILE, m); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5769'); } }
  function loadStickerPool() {
    try { const a = JSON.parse(fs.readFileSync(STICKER_POOL_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function saveStickerPool(items) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); atomicWriteJson(STICKER_POOL_FILE, items); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5774'); }
  }

  // [STICKER-POOL] 群里出现的图/表情先进候选池（不自动入库！她决定收不收）
  function recordStickerCandidate(key, mediaList, sender, messageRef) {
    try {
      if (cfg.socialV2?.sticker?.pool?.enabled === false) return;
      if (!String(key).startsWith('group:')) return;
      if (!Array.isArray(mediaList) || !mediaList.length || !messageRef) return;
      const first = mediaList.find((m) => m && (m.kind === 'face' || m.kind === 'image' || m.url || m.file));
      if (!first) return;
      const now = Date.now();
      const items = loadStickerPool().filter((x) => x && now - Number(x.at || 0) < STICKER_POOL_TTL_MS);
      if (items.some((x) => String(x.messageId) === String(messageRef))) return;
      items.push({ id: now.toString(36), key, messageId: String(messageRef), sender: String(sender || ''), media: first, at: now, desc: '', captionedAt: 0, shownAt: 0, collected: false });
      const trimmed = items.slice(-STICKER_POOL_CAP);
      saveStickerPool(trimmed);
      log(`[sticker-pool] ${key} 记下一条候选图（池 ${trimmed.length}）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5792'); }
  }

  // [STICKER-AUTO] 模型判定像表情包 → 自动加进 QQ 收藏（可关、有日上限、只收新图）。
  async function autoCollectStickerFromPool(target, caption) {
    const ac = cfg.socialV2?.sticker?.autoCollect ?? {};
    if (ac.enabled === false) return { ok: false, reason: 'disabled' };
    if (caption?.sticker === false || caption?.collect === false) return { ok: false, reason: 'not-worth' };
    if (String(caption?.meaning || '').trim().length < 6) return { ok: false, reason: 'no-meaning' };
    if (!Array.isArray(caption?.tags) || caption.tags.length < 2) return { ok: false, reason: 'few-tags' };
    const maxAgeMs = Number(ac.maxAgeMs) || 6 * 3600000;
    if (Date.now() - Number(target?.at || 0) > maxAgeMs) return { ok: false, reason: 'stale' };
    if (target.collected || target.autoCollected) return { ok: false, reason: 'done' };
    // [AUTO-PACE] 日额度 + 小时额度 + 最小间隔：防止像 10/28 那样 12 分钟内把 5 张额度烧光，
    // 然后一整天都不再收。纯函数在 sticker-autocollect.mjs（有单测），这里只负责落地 meta。
    const gate = evaluateAutoCollect({
      meta: poolMeta(),
      now: Date.now(),
      maxPerDay: Number(ac.maxPerDay) || 5,
      maxPerHour: Number(ac.maxPerHour) || 2,
      minIntervalMs: Number(ac.minIntervalMs) || 0,
    });
    if (!gate.ok) {
      setPoolMeta(gate.metaPatch);
      return { ok: false, reason: gate.reason };
    }
    const datas = await fetchMediaData([target.media]);
    const img0 = (datas || []).find((d) => d && d.data);
    if (!img0) return { ok: false, reason: 'no-image' };
    const imageHash = crypto.createHash('md5').update(Buffer.from(img0.data, 'base64')).digest('hex');
    try {
      const lib = loadStickerStore(STICKER_FILE);
      const dup = lib.find((e) => String(e.md5 || '').toLowerCase() === imageHash);
      if (dup) {
        target.autoCollected = true;
        target.collected = true;
        saveStickerPool(loadStickerPool().map((x) => (x.id === target.id ? target : x)));
        log(`[sticker-auto] 跳过重复：${imageHash.slice(0, 8)} 已在库（${String(dup.desc || '').slice(0, 14)}）`);
        return { ok: false, reason: 'duplicate' };
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5832'); }
    const img = (datas || []).find((d) => d && d.data);
    if (!img) return { ok: false, reason: 'no-image' };
    const addRes = await getBot().request('add_custom_face', { file: 'base64://' + img.data });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    const emojiId = String(addRes.data?.emoji_id || '');
    const remark = String(caption?.note || caption?.name || '').slice(0, 20);
    if (emojiId && remark) {
      try { await getBot().request('modify_custom_face', { emoji_id: emojiId, desc: remark }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5840'); }
    }
    try { await syncStickerLibrary(true); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5842'); }
    setPoolMeta(gate.metaPatch);
    target.autoCollected = true;
    target.collected = true;
    saveStickerPool(loadStickerPool().map((x) => (x.id === target.id ? target : x)));
    log(`[sticker-auto] 自动收藏「${String(caption?.name || '').slice(0, 16)}」${remark ? '（备注：' + remark.slice(0, 12) + '…）' : ''}`);
    return { ok: true, emojiId };
  }

  // 一次给池里一张图打标（5 分钟一轮，最多一张，成本可控）
  async function captionPoolOne(opts = {}) {
    let target = null;
    try {
      if (!isDshReady?.() || !stickerEnabled()) return { ok: false, reason: 'not-ready' };
      const now = Date.now();
      // [POOL-THROTTLE] 持久化节流：桥接被频繁重启时，内存计时器会一直归零 → 永远不触发。
      const meta = poolMeta();
      if (!opts?.force && now - Number(meta.lastCaptionAt || 0) < 3 * 60 * 1000) return { ok: false, reason: 'throttled' };
      const items = loadStickerPool();
      // [CAPTION-BACKOFF] 同一张失败过就指数退避，3 次后跳过：否则 402/超时会让
      // 它每 3 分钟重试同一张，整晚刷日志并白烧一次看图 turn（2026-10-30 实测）。
      target = items.find((x) => x && !x.desc && !x.collected
        && now - Number(x.at || 0) < STICKER_POOL_TTL_MS
        && evaluateCaptionRetry(x, { now }).ok);
      if (!target) return { ok: false, reason: 'nothing' };
      setPoolMeta({ lastCaptionAt: now, lastTargetAt: Number(target.at) || 0 });
      const datas = await fetchMediaData([target.media]);
      const img = (datas || []).find((d) => d && d.data);
      if (!img) {
        target.captionAttempts = (Number(target.captionAttempts) || 0) + 1;
        target.captionFailedAt = now;
        target.captionLastError = 'no-image';
        if (target.captionAttempts >= 3) target.captionSkipped = true;
        saveStickerPool(items);
        return { ok: false, reason: 'no-image' };
      }
      const text = await visionAsk([img.data], STICKER_CAPTION_PROMPT, img.mimeType || 'image/png');
      const { name, tags, note, meaning, sticker, collect } = parseStickerCaption(text);
      const imageHash = crypto.createHash('md5').update(Buffer.from(img.data, 'base64')).digest('hex');
      target.desc = name || '（没看清）';
      target.tags = tags || [];
      target.note = note || '';
      target.meaning = meaning || '';
      target.imageHash = imageHash;
      target.isSticker = sticker !== false;
      target.collect = collect !== false;
      target.captionedAt = now;
      delete target.captionAttempts;
      delete target.captionFailedAt;
      delete target.captionLastError;
      delete target.captionSkipped;
      saveStickerPool(items);
      log(`[sticker-pool] 打标：${target.desc}${target.isSticker ? '' : '（判定不像表情包）'}（${target.key}，${target.sender || '某人'}）`);
      if (target.isSticker) {
        try { await autoCollectStickerFromPool(target, { name: target.desc, tags: target.tags, note: target.note, meaning: target.meaning, sticker, collect }); } catch (error) { log(`[sticker-auto] 自动收藏失败: ${error?.message ?? error}`); }
      }
      return { ok: true, desc: target.desc };
    } catch (error) {
      // 失败也要落盘：不落盘 = 下一次还是同一张，永远打不完。
      if (target) {
        try {
          target.captionAttempts = (Number(target.captionAttempts) || 0) + 1;
          target.captionFailedAt = Date.now();
          target.captionLastError = String(error?.message ?? error).slice(0, 120);
          if (target.captionAttempts >= 3) target.captionSkipped = true;
          saveStickerPool(loadStickerPool().map((x) => (x && x.id === target.id ? target : x)));
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5908'); }
      }
      log(`[sticker-pool] 打标失败: ${error?.message ?? error}${target?.captionSkipped ? '（已跳过该候选）' : ''}`);
      return { ok: false, reason: 'error' };
    }
  }

  // 唤醒时递「群里最近这几张」：事实 + 许可，收不收她定；同一张只递一次
  function stickerPoolLine(key, max = 3) {
    try {
      if (cfg.socialV2?.sticker?.pool?.inject === false) return '';
      if (!String(key).startsWith('group:')) return '';
      const now = Date.now();
      const items = loadStickerPool();
      const fresh = items.filter((x) => x && x.key === key && x.desc && !x.shownAt && !x.collected && now - Number(x.captionedAt || 0) < 12 * 3600000).slice(-Math.max(1, max));
      if (!fresh.length) return '';
      const lines = fresh.map((x) => `- ${x.desc}${x.tags?.length ? ' [' + x.tags.join('/') + ']' : ''}（${x.sender || '某人'}发的，messageId=${x.messageId}）`);
      const ids = new Set(fresh.map((x) => x.id));
      saveStickerPool(items.map((x) => (ids.has(x.id) ? { ...x, shownAt: now } : x)));
      // [STICKER-OBS] 递给她时留一行：收不收是她的事，但"有没有递到"必须可查
      try { log(`[sticker-pool] 递给她 ${fresh.length} 张候选（${fresh.map((x) => String(x.desc || '').slice(0, 12)).join(' / ')}）`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'sticker-pool-service.mjs:5928'); }
      return `【群里最近的图】这几张是刚才群里出现的（机器看的样子，可能不准）：\n${lines.join('\n')}\n想收就 qq_collect_sticker(messageId=…，备注可选)，不想收就放着——不用为了收而收。\n\n`;
    } catch { return ''; }
  }

  // 启动后给没备注的表情补一轮标（每次最多 2 张）；池子每 5 分钟处理一张
  setTimeout(() => { void captionStickerLibrary({ limit: 2 }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/sticker-pool-service.mjs:221')); }, 25000).unref?.();
  const stickerPoolTimer = setInterval(() => { void captionPoolOne().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/sticker-pool-service.mjs:222')); }, 60 * 1000);
  stickerPoolTimer.unref?.();
  // ── [ACTIVITY-FLUSH] 她玩手机的活动段要落账 ────────────────────────────────
  // tracker 的 finish() 原来只挂在"聊天回合结束"上，而自主时间是隔离会话，不走那条路径，
  // 结果成功段一条都没写进 data/state/traces（2026-10-29 实测：当天 0 条，只有失败打点）。
  // 这里改成空闲收尾：3 分钟没有新的手机动作就落一条 trace，跟会话类型无关。

  function stickerResyncAfterOpen() {
    if (cfg.socialV2?.sticker?.enabled === false) return;
    if (getStickerSyncedAt()) return;
    const now = Date.now();
    if (now - Number(getStickerResyncAt() || 0) < 60000) return;
    setStickerResyncAt(now);
    setTimeout(() => {
      syncStickerLibrary(true).then((res) => {
        if (res && !res.fromCache) log(`[sticker] 启动补同步成功：${res.entries.length} 个收藏表情`);
      }).catch((error) => log(`[sticker] 启动补同步失败: ${error?.message ?? error}`));
    }, 5000).unref?.();
  }

  return {
    stickerResyncAfterOpen,
    captionStickerLibrary, poolMeta, setPoolMeta, loadStickerPool, saveStickerPool,
    recordStickerCandidate, autoCollectStickerFromPool, captionPoolOne, stickerPoolLine,
  };
}
