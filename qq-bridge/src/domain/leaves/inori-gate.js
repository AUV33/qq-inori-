// inori-gate.js · 群聊「注意门」的纯函数层（级联门 ② 精判级）。
// ① 向量粗筛由桥接直连本地 bge-m3 服务（fetch /v1/embeddings），不经过本模块；
// ② 本模块负责：锚点整理、批次门控、精判 prompt 生成、flash 回复解析、余弦数学。
// 纪律：纯函数、零 IO、零世界知识（agentName/锚点全由调用方注入）。

export const GATE_DEFAULTS = Object.freeze({
  minPending: 5,          // 未门消息攒够多少条才判（太稀不值得一次 flash）
  intervalMs: 90_000,    // 距上次门判的最短间隔（活跃窗口上限 ~1 次/90s）
  batchMax: 20,          // 单次门判的消息上限（截尾）
  msgChars: 80,          // 单条消息进 prompt 前的截断长度
  cosThreshold: 0.60,    // ① 粗筛原始 cosine 门槛（bge-m3 窄带分布，48h 日志后校准）
  embedBatch: 16,        // 单次 /v1/embeddings 请求的文本数上限
});

/** 锚点清单整理：去重、截断、限量（prompt 里有字数预算）。 */
export function anchorSet({ selfName = '', keywords = [], goalTitles = [], openLoops = [], recentTopics = [] }, { maxAnchors = 12, maxChars = 30 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (!s || s.length > maxChars || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  push(selfName);
  // [INPUT-ROBUST] 这些清单可能来自 config，写成字符串/非法值时不该整条门判崩掉
  const listOf = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  listOf(keywords).forEach(push);
  listOf(goalTitles).forEach(push);
  listOf(openLoops).forEach(push);
  listOf(recentTopics).forEach(push);
  return out.slice(0, maxAnchors);
}

/** 该不该对这批未门消息发起门判。 */
export function shouldBatch({ pending, lastGateAt = 0, now = Date.now(), minPending = GATE_DEFAULTS.minPending, intervalMs = GATE_DEFAULTS.intervalMs }) {
  return pending >= minPending && (now - lastGateAt) >= intervalMs;
}

/** 批次消息规范化：编号、截断（给粗筛 embedding 与精判 prompt 共用一份）。 */
export function shapeMessages(messages, { batchMax = GATE_DEFAULTS.batchMax, msgChars = GATE_DEFAULTS.msgChars }) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf && String(m.text ?? '').trim());
  return list.slice(-batchMax).map((m, i) => ({
    i: i + 1,
    // [SEQ-KEEP] 必须带 seq：markGateSeen() 靠它推进 gateHighSeq，否则同一批未读会被
    // 每轮重复送进粗筛+精判（白烧 embedding 与 flash 调用，还可能重复投递）。
    seq: Number.isSafeInteger(Number(m.seq)) ? Number(m.seq) : 0,
    sender: String(m.sender ?? '').slice(0, 30),
    text: String(m.text ?? '').trim().replace(/\s+/g, ' ').slice(0, msgChars),
  }));
}

/** 精判 prompt 文本（桥接把它作为 gate 会话的一次 user message 发出）。 */
export function gatePayloadText({ agentName, anchors, messages }) {
  const a = (anchors ?? []).length ? (anchors ?? []).map((x, n) => `${n + 1}. ${x}`).join('\n') : '（无）';
  const m = (messages ?? []).map((x) => `${x.i}. [${x.sender || '?'}] ${x.text}`).join('\n');
  return [
    '【判定请求】',
    `【Agent】${String(agentName ?? '')}`,
    `【锚点】\n${a}`,
    `【消息批次】\n${m || '（空批次）'}`,
    '按系统规则输出严格 JSON。',
  ].join('\n');
}

/** flash 回复解析：容忍代码块/前后缀，取第一段 JSON。 */
export function parseGateReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { hits: [], raw };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { hits: [], raw };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const hits = (Array.isArray(obj?.hits) ? obj.hits : [])
      .filter((h) => h && Number.isFinite(Number(h.i)) && Number(h.i) >= 1)
      .map((h) => ({ i: Number(h.i), why: String(h?.why ?? '').slice(0, 40) }));
    return { hits, raw };
  } catch {
    return { hits: [], raw };
  }
}

/** 余弦相似度（两个等长向量；长度不齐返回 -1，让调用方按"不命中"处理）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 一批文本对锚点向量的最高 cosine（粗筛用）：返回 {best, anchor, indices}。 */
export function maxAnchorCosine(vecs, anchorVecs) {
  let best = -1, anchor = null;
  for (const v of vecs ?? []) {
    if (!Array.isArray(v)) continue;
    for (const av of anchorVecs ?? []) {
      if (!Array.isArray(av)) continue;
      const c = cosine(v, av);
      if (c > best) { best = c; anchor = av.name ?? null; }
    }
  }
  return { best, anchor };
}

/** 把 embed 服务按批切好请求块（≤embedBatch 条/块，纯文本列表）。 */
export function embedChunks(texts, { batch = GATE_DEFAULTS.embedBatch } = {}) {
  const out = [];
  for (let i = 0; i < (texts?.length ?? 0); i += batch) out.push(texts.slice(i, i + batch));
  return out;
}

// ── [GATE-TUNE] 门敏感度动态调整（她 gate_tune 工具 / 主人改 config） ─────────
// 范围 = bge-m3 窄带 cosine 分布的「有意义区间」（48h 日志校准）：
// 低于 0.40 粗筛形同虚设（≈全部批次进 flash 精判，成本白烧）；
// 高于 0.80 几乎什么都不过（门≈关闭，她彻底听不见群）。两端之外没有调的意义。
export const GATE_SENSITIVITY_RANGE = Object.freeze({ min: 0.4, max: 0.8 });

export function clampGateSensitivity(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(GATE_SENSITIVITY_RANGE.max, Math.max(GATE_SENSITIVITY_RANGE.min, n));
}

/** 生效阈值：她的覆盖值优先（合法数字才认），否则 config 基线；都收进范围。 */
export function effectiveGateThreshold(base, override) {
  const candidate = (override !== null && override !== undefined && String(override).trim() !== '' && Number.isFinite(Number(override)))
    ? Number(override)
    : Number(base);
  return clampGateSensitivity(candidate) ?? GATE_DEFAULTS.cosThreshold;
}

/** 解析 state/gate-sensitivity.json 的原文（纯函数，零 IO）：合法才返回对象，否则 null。 */
export function parseGateSensitivityOverride(text) {
  let raw = String(text ?? '').trim();
  if (!raw) return null;
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out = {};
    if (Number.isFinite(Number(obj.cosThreshold))) out.cosThreshold = Number(obj.cosThreshold);
    if (obj.by) out.by = String(obj.by).slice(0, 16);
    if (obj.reason) out.reason = String(obj.reason).slice(0, 100);
    if (obj.at) out.at = String(obj.at).slice(0, 40);
    return out;
  } catch {
    return null;
  }
}
