// [LOCAL-JUDGE] 少样本示例检索：用已有 bge-m3 把"手写小样本库"里最像的 2 条挑出来喂 3B
// 不新增模型、不需要历史标注；就是在向量空间里找近邻示例（GitHub 上 RAG/few-shot routing 的做法）。

// 手写小样本库：覆盖"方向/玩笑/试探/倾诉/发火/亲近"这些 3B 最容易判错的形态
export const AFFECT_EXAMPLES = [
  { text: '我真的撑不住了', affect: '倾诉', target: '自己' },
  { text: '我快崩溃了，没人听我说', affect: '倾诉', target: '自己' },
  { text: '你他妈烦不烦', affect: '发火', target: '你' },
  { text: '滚吧别管我', affect: '发火', target: '你' },
  { text: '太傻逼了这个人', affect: '发火', target: '别人' },
  { text: '这软件真恶心', affect: '发火', target: '无' },
  { text: '你是不是嫌我烦', affect: '试探', target: '你' },
  { text: '你是不是在敷衍我', affect: '试探', target: '你' },
  { text: '哈哈哈哈哈笑死', affect: '玩笑', target: '无' },
  { text: '你个傻蛋哈哈哈', affect: '玩笑', target: '你' },
  { text: '谢谢你还记得', affect: '亲近', target: '你' },
  { text: '今天下午三点开会', affect: '平稳', target: '无' },
  { text: '你看我干嘛', affect: '平稳', target: '你' },
];

function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * @param {string} text 当前消息
 * @param {{embed:(texts:string[])=>Promise<number[][]>, bank?:object[], top?:number, minSim?:number}} opts
 */
export async function pickExamples(text, { embed, bank = AFFECT_EXAMPLES, top = 2, minSim = 0.45 } = {}) {
  if (typeof embed !== 'function') return [];
  try {
    const texts = [String(text || ''), ...bank.map((b) => b.text)];
    const vecs = await embed(texts);
    if (!Array.isArray(vecs) || vecs.length !== texts.length || !vecs[0]) return [];
    const scored = bank.map((b, i) => ({ ...b, sim: cosine(vecs[0], vecs[i + 1]) }))
      .filter((x) => x.sim >= minSim)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, Math.max(1, Number(top) || 2));
    return scored;
  } catch { return []; }
}

// 供桥接复用：把示例库缓存成文件，避免每次重新算（bge-m3 只算一次）
