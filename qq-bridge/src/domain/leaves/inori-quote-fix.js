// [QUOTE-FIX] 她把自己的话用「」包起来：把整条被包的拆掉，落单的引号去掉；句中成对引用保留
// 依据：实测 10 条群发言里 4 条整条被「」包住（00:58–01:02），角色卡第 25 行早就写了“别用「」括自己”
export function stripSelfQuoting(text) {
  let s = String(text ?? '');
  if (!s || !/[「」『』]/.test(s)) return s;
  const pairs = [['「', '」'], ['『', '』']];
  // 整条被包住（可能多层）→ 逐层剥
  let changed = true;
  while (changed) {
    changed = false;
    for (const [l, r] of pairs) {
      const t = s.trim();
      if (t.startsWith(l) && t.endsWith(r)) {
        const inner = t.slice(l.length, t.length - r.length);
        // 内部不能再有同层未闭合的同类引号，否则说明是“引用别人 + 自己接着说”，不剥
        if (!inner.includes(l) || !inner.includes(r)) { s = inner.trim(); changed = true; break; }
      }
    }
  }
  // 落单的引号（只有左边或只有右边）直接去掉
  for (const [l, r] of pairs) {
    const nl = (s.match(new RegExp(l, 'g')) || []).length;
    const nr = (s.match(new RegExp(r, 'g')) || []).length;
    if (nl !== nr) {
      if (nl > nr) s = s.split(l).join('');
      else s = s.split(r).join('');
    }
  }
  return s.trim();
}
