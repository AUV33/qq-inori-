// probe-affect-embed.mjs · 只读探针：用本机 bge-m3（8790）做"小样本语义分类"，
// 看本地嵌入模型能不能帮上"读别人的心理/感受"这类判断（替代/补充正则）。
// 不写任何状态、不调云端模型、不改变她的行为。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8790';
const MODEL = 'bge-m3';

const BANK = {
  倾诉: ['我真的撑不住了', '好难受，想哭', '没人能听我说', '最近压力太大了', '我不知道该怎么办', '心里堵得慌', '好累，好像一直在硬扛'],
  发火: ['你他妈烦不烦', '滚吧别管我', '太恶心了', '凭什么啊', '闭嘴', '我真服了你了'],
  试探: ['你是不是嫌我烦', '你是不是觉得我很没用', '你是不是在敷衍我', '我这人是不是很讨人厌', '你还会理我吗'],
  玩笑: ['哈哈哈哈笑死', '草你个小机灵鬼', '你这傻蛋哈哈哈', '绷不住了', '笑死我了狗头'],
  亲近: ['谢谢你还记得', '你今天真好', '抱抱', '晚安啦', '有你真好', '嘿嘿嘿'],
};

const j = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const samples = [];
for (const [key, st] of Object.entries(j.conversations || {})) {
  for (const m of st.recentMessages || []) {
    if (!m || m.isSelf) continue;
    const t = String(m.text || '').replace(/\[引用[^\]]*\]/g, '').replace(/\[CQ:[^\]]*\]/g, '').replace(/@\S+/g, '').trim();
    if (t.length < 2 || /^\[图片\]$|^\[视频\]$|^\[拍一拍\]/.test(t)) continue;
    samples.push({ key, text: t, at: m.time });
  }
}

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const chunk = texts.slice(i, i + 16);
    const r = await fetch(`${BASE}/v1/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: chunk }), signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
    const d = await r.json();
    for (const item of (d.data || []).slice().sort((a, b) => a.index - b.index)) out.push(item.embedding);
  }
  return out;
}
const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); };

const classNames = Object.keys(BANK);
const bankTexts = classNames.flatMap((c) => BANK[c]);
const all = await embed([...bankTexts, ...samples.map((s) => s.text)]);
const bankVecs = all.slice(0, bankTexts.length);
const sampleVecs = all.slice(bankTexts.length);

const centroids = {};
let off = 0;
for (const c of classNames) {
  const n = BANK[c].length;
  const vs = bankVecs.slice(off, off + n);
  off += n;
  const dim = vs[0].length;
  const cen = new Array(dim).fill(0);
  for (const v of vs) for (let i = 0; i < dim; i++) cen[i] += v[i] / n;
  centroids[c] = cen;
}

const tally = Object.fromEntries(classNames.map((c) => [c, 0]));
const rows = [];
for (let i = 0; i < samples.length; i++) {
  const v = sampleVecs[i];
  const scored = classNames.map((c) => ({ c, s: cos(v, centroids[c]) })).sort((a, b) => b.s - a.s);
  const top = scored[0], second = scored[1];
  const margin = top.s - second.s;
  tally[top.c] += 1;
  rows.push({ ...samples[i], cls: top.c, sim: +top.s.toFixed(3), margin: +margin.toFixed(3) });
}
rows.sort((a, b) => b.margin - a.margin);

console.log(`样本 ${samples.length} 条（白名单内会话的真实来信）｜口径：类中心余弦，margin=top1-top2`);
console.log('分布:', JSON.stringify(tally));
const margins = rows.map((r) => r.margin).sort((a, b) => a - b);
const q = (p) => margins[Math.min(margins.length - 1, Math.floor(margins.length * p))];
console.log(`margin: 中位 ${q(0.5)} | p75 ${q(0.75)} | p90 ${q(0.9)}`);
console.log('');
console.log('最像的 6 条（高 margin）：');
for (const r of rows.slice(0, 6)) console.log(`  [${r.cls} ${r.sim} m=${r.margin}] ${r.key} :: ${r.text.slice(0, 40)}`);
console.log('');
console.log('最模糊的 6 条（低 margin，说明这类判不了）：');
for (const r of rows.slice(-6)) console.log(`  [${r.cls} ${r.sim} m=${r.margin}] ${r.key} :: ${r.text.slice(0, 40)}`);
