// 入站「读一下 / 记一下」：网页正文读取（safe-fetch + Edge 渲染兜底）与 intake 投递。
//
// 从 app.mjs 的 main() 搬出（P3-RW-30，2026-11-01）。intakeLast / linkCache 状态留在本模块；
// 反思产出检查只记日志，不阻塞。
/**
 * @param {object} ctx
 */
export function createIntakeService(ctx) {
  const {
    fs, cfg, log, MEM_DIR, writeJsonDocument, INTAKE_STATE_FILE, intakeLast,
    loadLessons, makeLinkCache, safeFetch, shouldIntake, buildIntakePrompt, deliverToIsolated,
  } = ctx;
  function saveIntakeState() {
    try {
      writeJsonDocument(INTAKE_STATE_FILE, Object.fromEntries(intakeLast), { source: 'bridge/intake' });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'intake-service.mjs:8807'); }
  }
  const countLearnables = () => {
    try {
      const mem = fs.readFileSync(MEM_DIR + '/memory.jsonl', 'utf8').split('\n').filter((l) => l.trim()).length;
      return mem + loadLessons(cfg.socialV2?.lessons?.file).length;
    } catch { return 0; }
  };
  // [INTAKE] 读一个网页：先直连，正文太短（SPA 空壳）再用无头 Edge 渲染一次。
  // 为什么要渲染：实测小黑盒分享页直连只有 97 字符的壳，正文全在 JS 里。
  const EDGE_CANDIDATES = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  function stripHtml(html) {
    return String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // 链接正文读取上限：注入前只截 1200 字，但抓取阶段也必须限量，否则单页就能吃爆内存。
  const INTAKE_MAX_CHARS = 200 * 1024;
  const linkCache = makeLinkCache(30 * 60 * 1000);
  async function readPageForIntake(url, allowRender = true) {
    const cached = linkCache.get(url);
    if (cached && cached.text && cached.text.length >= 300) return { ...cached, fromCache: true };
    let html = '';
    let blocked = false;
    try {
      // [SEC] 链接来自群聊/私聊文本，是不可信输入：必须走 safe-fetch。
      // 它拦内网/环回/CGNAT、DNS 解析后逐跳校验重定向、限量读取。
      // 原来这里直接 fetch(url)，等于给聊天里任意 URL 开了一条只读 SSRF 通道。
      const res = await safeFetch(url, INTAKE_MAX_CHARS);
      if (res.statusCode >= 200 && res.statusCode < 300) html = res.body;
    } catch (error) {
      blocked = true;
      log(`[intake] 链接抓取被拒绝或失败（${String(url).slice(0, 80)}）: ${error?.message ?? error}`);
    }
    let title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1] ?? '').trim();
    let text = stripHtml(html);
    if (blocked || text.length >= 300 || !allowRender) return { title, text, rendered: false };
    // 渲染兜底
    const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!edge) return { title, text, rendered: false, note: 'no-edge' };
    try {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve, reject) => {
        execFile(edge, ['--headless=new', '--disable-gpu', '--dump-dom', '--virtual-time-budget=4000', url],
          { timeout: 25000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const rHtml = String(out ?? '');
      const rText = stripHtml(rHtml);
      if (rText.length > text.length) {
        title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(rHtml)?.[1] ?? title).trim();
        const out = { title, text: rText, rendered: true };
        if (rText.length >= 300) linkCache.set(url, out);
        return out;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'intake-service.mjs:8869'); }
    return { title, text, rendered: false };
  }
  function maybeIntake(key, userText, selfText, seen = '') {
    try {
      if (cfg.socialV2?.intake?.enabled === false) return;
      const decision = shouldIntake({
        text: userText,
        now: Date.now(),
        lastIntakeAt: intakeLast.get(key) ?? null,
      }, cfg.socialV2?.intake ?? {});
      if (!decision.yes) { log(`[intake] 跳过 ${key}（${decision.reason}）`); return; }
      intakeLast.set(key, Date.now());
      saveIntakeState();
      const before = countLearnables();
      const prompt = buildIntakePrompt({ userText, selfText, seen, scope: String(key).startsWith('group:') ? key : null });
      // 延后投递：等这一轮彻底收尾，避免和回复/沉睡流程抢同一个会话
      setTimeout(() => {
        deliverToIsolated('intake', prompt, { key, reason: 'intake' })
          .then(() => {
            log(`[intake] ${key} 已投递提炼提示（${decision.reason}，此前可学条目 ${before}）`);
            setTimeout(() => {
              const after = countLearnables();
              const added = Math.max(0, after - before);
              log(`[intake] 产出检查 ${key}：新增 ${added} 条${added > 0 ? '' : '（未产生，属正常：她说没有值得记的）'}`);
            }, 90 * 1000).unref?.();
          })
          .catch((error) => log(`[intake] 投递失败（已忽略）: ${error?.message ?? error}`));
      }, 20 * 1000).unref?.();
    } catch (error) {
      log(`[intake] 调度失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  return { saveIntakeState, stripHtml, readPageForIntake, maybeIntake };
}
