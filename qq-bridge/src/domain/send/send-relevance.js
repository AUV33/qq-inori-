// send-relevance.js · 发送前的「接得上吗」检查（宽松版）
//
// 用本地 bge-m3 把「她要说的话」和「最近几条别人的话」做一次余弦；
// 低于阈值说明她很可能在接一个已经翻篇的话题（牛头不对马嘴）。
//
// 纪律：
// - 只做否决，不做改写；拿不到向量就放行（宁可让她说，也不因为工程故障把她嘴堵住）。
// - 阈值默认 0.25（宽松）：只拦「完全不搭」的，正常接话不在这个量级。
// - 只给群聊用；私聊不拦。
const DEFAULT_URL = 'http://127.0.0.1:8790/v1/embeddings';
const DEFAULT_MODEL = 'bge-m3';

function cos(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {string} text 她准备发出去的话
 * @param {string[]} recent 最近几条别人的话
 * @param {{url?:string, model?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{cos:number}|null>} null = 拿不到向量（调用方应放行）
 */
export async function relevanceCos(text, recent, opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = Number(opts.timeoutMs) || 800;
  const docs = (Array.isArray(recent) ? recent : []).map((s) => String(s || '').trim()).filter(Boolean).slice(-6);
  const body = [String(text || ''), ...docs];
  if (!String(text || '').trim() || !docs.length) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const vecs = (Array.isArray(j?.data) ? j.data : []).map((d) => d?.embedding).filter(Array.isArray);
    if (vecs.length !== body.length) return null;
    const [q, ...rest] = vecs;
    let best = -1;
    for (const d of rest) best = Math.max(best, cos(q, d));
    return Number.isFinite(best) ? { cos: best } : null;
  } catch {
    return null;
  }
}

