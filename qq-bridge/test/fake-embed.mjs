// fake-embed.mjs · 离线确定性 embedder 桩（仅供测试/金标准回归用，不进生产）
//
// 为什么：真实 embed 是外部 HTTP 模型，npm test 离线跑不了召回金标准。这个桩用
// FNV 哈希把文本二元组投影到固定维向量，余弦相似度≈二元组重合度——足够让召回
// 排序逻辑（cos + 动量 + 重要度 + 字面）在离线被端到端回归。换上真实模型时，同一套
// 金标准 harness 直接复用，只是把 injectEmbed 换成真实 embed。
//
// 不是"假数据骗测试"：它锁的是**排序管线**的回归边界；模型质量由真实 embed 在 CI 单独守。
export const FAKE_EMBED_DIM = 1024;

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  if (!s) return out;
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 返回一个 async (texts) => vectors[] 的 embedder，签名与 memory-retrieve 的 embed 一致。
 * @param {number} [dim]
 */
export function makeFakeEmbed(dim = FAKE_EMBED_DIM) {
  return async function fakeEmbed(texts) {
    const list = Array.isArray(texts) ? texts : [];
    return list.map((t) => {
      const grams = bigrams(t);
      const v = new Array(dim).fill(0);
      // [非负累加] 相似文本在共有二元组桶上同向累加 → 余弦随重合度单调上升；
      // 不用随机符号（会让共有桶正负抵消，导致近重复余弦≈0，召回失效）。
      for (const g of grams) {
        const h = fnv1a(g);
        const d = h % dim;
        v[d] += 1;
      }
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
  };
}
