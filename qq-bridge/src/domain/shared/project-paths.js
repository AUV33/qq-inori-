// project-paths.js · 项目路径的单一来源。
// 默认根据本文件位置推导仓库根目录；测试/第二实例可用 QQ_INORI_ROOT 覆盖。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inferredRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const PROJECT_ROOT = path.resolve(process.env.QQ_INORI_ROOT || inferredRoot);
export const QQ_BRIDGE_DIR = path.join(PROJECT_ROOT, 'qq-bridge');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const STATE_DATA_DIR = path.join(DATA_DIR, 'state');
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

export function projectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

export function stateDataPath(...parts) {
  return path.join(STATE_DATA_DIR, ...parts);
}

export function bridgePath(...parts) {
  return path.join(QQ_BRIDGE_DIR, ...parts);
}
