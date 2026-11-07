// quant/strategies/index.js · 策略注册表
//
// 新增策略：在本目录写一个导出 `xxxStrategy(params)` 的文件（返回 { name, onBar }），
// 再在这里登记一行。策略只做"看 K 线 → 给信号"，不碰现金、不记账。

import { smaCrossStrategy } from './sma-cross.js';
import { breakoutStrategy } from './breakout.js';

export const STRATEGIES = Object.freeze({
  'sma-cross': smaCrossStrategy,
  breakout: breakoutStrategy,
});

export const STRATEGY_NAMES = Object.keys(STRATEGIES);

export function createStrategy(name, params = {}) {
  const factory = STRATEGIES[String(name)];
  if (!factory) throw new Error(`未知策略: ${name}（可用：${STRATEGY_NAMES.join(', ')}）`);
  return factory(params);
}
