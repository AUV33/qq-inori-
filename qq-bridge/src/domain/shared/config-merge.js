// config-merge.js · socialV2 子对象的一层深合并（纯函数，可单测）
//
// 背景：loadConfig 原来用 `...(file.socialV2 ?? {})`，只覆盖顶层。用户只写
// `socialV2.wait.defaultQuietMs` 时，wait 的 replyDebounceMs / minQuietAfterNewMs
// 等默认值会整块丢掉，表现为“配置只改一半，另一半回默认”。
//
// 只合并普通对象；数组和标量按用户值覆盖；undefined 不覆盖默认值。
export function mergeSocialV2Defaults(defaults = {}, incoming = {}) {
  const src = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) ? incoming : {};
  const out = { ...defaults, ...src };
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) {
      out[key] = defaults[key];
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)
        && defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      const child = {};
      for (const [ck, cv] of Object.entries(value)) {
        if (cv !== undefined) child[ck] = cv;
      }
      out[key] = { ...defaults[key], ...child };
    }
  }
  return out;
}
