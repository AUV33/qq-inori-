// [AT-SPLIT] 队列修剪：焦点被读掉时不要整队清空，而是推进到下一条还活着的 @
export function pruneSplitQueue(list, unreadSeqs) {
  const alive = new Set((Array.isArray(unreadSeqs) ? unreadSeqs : []).map(Number));
  const queue = (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!queue.length) return { queue: [], focus: 0, changed: false };
  const remaining = queue.filter((seq) => alive.has(seq));
  if (remaining.length === queue.length) return { queue, focus: queue[0], changed: false };
  return { queue: remaining, focus: remaining[0] ?? 0, changed: true };
}
