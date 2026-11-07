// config-check.mjs · 配置体检（纯函数，不读文件、不改配置）
//
// 为什么需要它（2026-10-27 的真实缺陷模式）：
//   bridge.js 的 `loadConfig()` 是**白名单式**的——它按名字一个个把 config.json 的键
//   拷进 `cfg`。写错一个键名、或写了一个还没接线的键，不会报错，只会**静默不生效**。
//   同类缺陷在隔壁 Mizuse 项目已经踩过：persona_config 的键全进 `pcfg`，而代码读 `cfg`，
//   三个新开关永远拿不到值，日志里一点痕迹都没有。
//
// 为什么不做一份手写 schema：
//   白名单就是 `loadConfig()` 本身，任何另写的 schema 都会和它漂移——
//   证据：`config.json` 与 `config.example.json` 已经双向漂移了 16 个键。
//   所以这里不定义"配置长什么样"，而是拿**加载后的结果**当权威形状：
//   原始文件里有、结果里没有 ⇒ 被丢弃。零维护、不会再漂。
//
// 纪律：只报告，不修改、不抛错。要不要因此拒绝启动，是调用方的决定。

/** 配置里合法的"别名"：原始文件用旧名字写，加载器会映射到新名字。这些不算被丢弃。 */
export const CONFIG_ALIASES = Object.freeze([
  'allow.privates',
  'allow.group',
  'deny.privates',
  'deny.group',
]);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 把对象拍平成叶子路径（数组整体算一个叶子；空对象算一个叶子）。
 * 例：{ a: { b: 1 }, c: [], d: {} } → ['a.b', 'c', 'd']
 */
export function flattenConfig(value, prefix = '', out = []) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) { out.push(prefix); return out; }
    for (const key of keys) flattenConfig(value[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (prefix) out.push(prefix);
  return out;
}

/**
 * 找出「原始配置里有、但加载结果里没有」的键 —— 也就是被白名单静默丢弃的键。
 *
 * @param {Record<string, unknown>} raw        config.json 解析出来的原始对象
 * @param {Record<string, unknown>} effective  loadConfig() 返回的 cfg
 * @param {{aliases?: string[]}} [options]
 * @returns {{path: string, value: unknown}[]}
 */
export function findDroppedKeys(raw, effective, options = {}) {
  const aliases = new Set(options.aliases ?? CONFIG_ALIASES);
  const dropped = [];

  const walk = (rawNode, effNode, prefix) => {
    if (!isPlainObject(rawNode)) return;
    for (const key of Object.keys(rawNode)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (aliases.has(path)) continue;
      const rawChild = rawNode[key];
      const hasEff = isPlainObject(effNode) && Object.prototype.hasOwnProperty.call(effNode, key);
      if (!hasEff) {
        dropped.push({ path, value: rawChild });
        continue;
      }
      // 两边都是对象才继续往下比；数组/标量视为同一个叶子
      if (isPlainObject(rawChild) && isPlainObject(effNode[key])) walk(rawChild, effNode[key], path);
    }
  };

  walk(raw ?? {}, effective ?? {}, '');
  return dropped;
}

/**
 * 比两套配置的形状（只比键路径，不比值）：example 是否覆盖了现网用到的键。
 * 用来防"照 example 新装一套，功能静默退回默认值"。
 *
 * @returns {{missingInExample: string[], extraInExample: string[]}}
 */
export function compareConfigShape(config, example) {
  const live = [...new Set(flattenConfig(config ?? {}))];
  const sample = new Set(flattenConfig(example ?? {}));
  // 空对象在 flatten 里是一个叶子；如果样例把同一路径展开成了子键，也算覆盖，
  // 否则 `memoryInject: {}` 这种"全用默认值"的现网写法会被误报成缺少。
  const covered = (path) => sample.has(path) || [...sample].some((candidate) => candidate.startsWith(`${path}.`));
  return {
    missingInExample: live.filter((path) => !covered(path)).sort(),
    extraInExample: [...sample].filter((path) => !live.includes(path)).sort(),
  };
}

/**
 * 生成给人看的一行/多行报告。
 * @param {{dropped?: {path: string}[], missingInExample?: string[], extraInExample?: string[]}} result
 */
export function formatConfigReport(result) {
  const lines = [];
  const dropped = result.dropped ?? [];
  const missing = result.missingInExample ?? [];
  const extra = result.extraInExample ?? [];
  if (!dropped.length && !missing.length && !extra.length) return ['配置体检通过：没有会被静默丢弃的键，example 与现网形状一致'];
  if (dropped.length) {
    lines.push(`⚠️ 会被静默丢弃的键（config.json 里写了，但加载器不认识）${dropped.length} 个：`);
    for (const item of dropped) lines.push(`   - ${item.path}`);
    lines.push('   影响：这些键不会生效，也不会报错。改名字或接线，别指望"写了就有"。');
  }
  if (missing.length) {
    lines.push(`⚠️ config.example.json 缺少现网正在使用的键 ${missing.length} 个：`);
    for (const path of missing) lines.push(`   - ${path}`);
    lines.push('   影响：照 example 新装一套，这些功能会静默退回默认值。');
  }
  if (extra.length) {
    lines.push(`ℹ️ example 里有、现网没配的键 ${extra.length} 个（说明是可选项，不算问题）：`);
    for (const path of extra) lines.push(`   - ${path}`);
  }
  return lines;
}
