// 纯工具函数（无模块级可变状态、无 I/O 副作用），[SPLIT] 从 src/app.mjs 抽出，
// 以便 app.mjs 瘦身、逻辑可独立复用/测试。

// 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。
export function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const convKey = (kind, id) => `${kind}:${id}`;

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
