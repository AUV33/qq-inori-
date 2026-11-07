// self-evolution-log.mjs · 进化账本的「读端」：谁改的、算不算她的成长
//
// 背景（审计 §8）：账本里 509 条 code_edit 全是 owner 侧会话改的，护栏只看见"文件变了"，
// 而她被注入「我最近改过自己：src/xxx」——假自画像。修法：记录写入方 actor，
// 读端只认 actor==='her'；没有她的记录就**不说这句话**。
//
// 纯函数、零 IO，单测直接钉住判定。

/** 算不算"她自己的改动" */
export function isHerEdit(row) {
  if (!row || row.actor !== 'her') return false;
  return row.kind === 'self_edit' || row.kind === 'code_edit';
}

/** 一条记录怎么描述（给她自己看的一句话里用） */
export function describeEdit(row) {
  if (!row) return '';
  if (row.file) return `${row.file}（${row.result || row.score || ''}）`;
  return `${row.target || '自己'}（${row.action || ''}）`;
}

/**
 * 从账本行里挑出"她最近真正改过自己"的那一条。
 * @param {Array<object>} rows 已解析的账本行（按写入顺序）
 * @param {object} opts { now, withinDays, kind }
 * @returns {object|null} 命中的那一行；没有就 null（调用方据此决定不说那句）
 */
export function pickHerRecentEdit(rows, { now = Date.now(), withinDays = 14 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const ms = Math.max(1, Number(withinDays) || 14) * 86400000;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i];
    if (!isHerEdit(row)) continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || now - at >= ms) continue;
    return row;
  }
  return null;
}
