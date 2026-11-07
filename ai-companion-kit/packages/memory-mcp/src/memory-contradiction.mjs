// memory-contradiction.mjs · 矛盾检测（F2/R5：全仓原 0 实现，仅写入时打 claimType 标签）
//
// 纯函数、可单测、不调模型。两条启发式规则：
//   1) 冲突标记：新条目 claimType==='conflict' 且库里有同 who/theme 的旧条目 → 标注"冲突记录"。
//   2) 态度反转：同一 who（或同 theme）下，新条目与某旧条目情感极性相反（喜欢/讨厌）→ 标注"态度前后相反"。
// 不阻塞写入，仅把命中结果附到 entry.contradicts，供后续检索/巩固消费。
// 注：真正的语义级矛盾解析需模型参与，本模块是"先有机制、先挡显式冲突"的第一刀。

const POS = ['喜欢', '爱', '想', '期待', '开心', '高兴', '最爱的', '最爱', '乐意', '愿意'];
const NEG = ['讨厌', '恨', '烦', '不想', '怕', '生气', '反感', '厌恶', '排斥', '拒绝'];

export function polarityOf(text) {
  const t = String(text ?? '');
  let p = 0;
  let n = 0;
  for (const w of POS) if (t.includes(w)) p += 1;
  for (const w of NEG) if (t.includes(w)) n += 1;
  if (p > 0 && n === 0) return 'pos';
  if (n > 0 && p === 0) return 'neg';
  return 'none';
}

export function detectContradictions(entry, existing = []) {
  const out = [];
  const who = entry.who || '';
  const theme = entry.theme || '';
  const newPol = polarityOf(entry.text);
  for (let i = 0; i < existing.length; i += 1) {
    const e = existing[i];
    const sameWho = who && e.who && e.who === who;
    const sameTheme = theme && e.theme && e.theme === theme;
    if (!sameWho && !sameTheme) continue;
    // 规则 1：显式冲突标记
    if (entry.claimType === 'conflict') {
      out.push({ withIndex: i, withTime: e.time, reason: `冲突记录：与 ${e.time} 关于「${who || theme}」的旧记录冲突` });
      continue;
    }
    // 规则 2：态度反转
    const ePol = polarityOf(e.text);
    if (newPol !== 'none' && ePol !== 'none' && newPol !== ePol) {
      out.push({ withIndex: i, withTime: e.time, reason: `对「${who || theme}」的态度前后相反（${ePol}→${newPol}）` });
    }
  }
  return out;
}
