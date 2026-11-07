// 运行模式别名：规范名与历史拼写收敛到同一内部值。
//
// 从 app.mjs 的 main() 外提（2026-11-02，开放源码架构收敛）。纯数据 + 纯函数，无 IO。
export const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});

/** 内部合法模式集合（由别名表派生，避免“两份名单各自漂移”）。 */
export const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
export function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}
