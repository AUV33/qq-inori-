// inori-paths.mjs · 项目根与常用目录的唯一来源（ai-companion-kit 侧）
//
// 为什么不写死 D:/<repo>：换盘、备份到别的机器、跑第二实例时都会错。
// 优先级：QQ_INORI_ROOT 环境变量 → 由本文件位置推导（packages/shared → 仓库根）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INORI_ROOT = process.env.QQ_INORI_ROOT
  ? path.resolve(process.env.QQ_INORI_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const dataPath = (...parts) => path.join(INORI_ROOT, 'data', ...parts);
export const statePath = (...parts) => dataPath('state', ...parts);
export const bridgeSrcPath = () => path.join(INORI_ROOT, 'qq-bridge', 'src');
export const bridgeStatePath = (...parts) => path.join(INORI_ROOT, 'qq-bridge', 'state', ...parts);
export const toolsPath = (...parts) => path.join(INORI_ROOT, 'tools', ...parts);
export const fileUrlOf = (file) => pathToFileURL(file).href;
