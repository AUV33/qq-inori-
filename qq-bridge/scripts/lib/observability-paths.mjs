// observability-paths.mjs · 可观测性读取路径的单一来源。
//
// 干什么：把 aliveness-report / incident-replay 各自 path.join(root,'data',...) 的重复拼接
//         收成一处，并显式区分两类状态根（历史上被混称为"双状态根"）。
// 为什么：app.mjs 的进程态在 qq-bridge/state（sessions/slang/token，57 个真实文件），
//         观测账本在 data/state（action-log/floor-decisions/lessons…）。二者不是重复，
//         是两个用途；但观测脚本必须只读后者，且不能再各写一份常量导致漂移。
// 输入输出：obsPaths(root?) → 绝对路径集合；root 可注入（测试用临时目录）。
// 失败模式：不做 IO、不创建目录；纯路径计算。
// 不做什么：不迁移真实数据（搬动会丢状态），不决定业务文件名之外的内容。

import path from 'node:path';
import { PROJECT_ROOT } from '../../src/domain/shared/project-paths.js';

/** 进程私有状态（sessions/lock/token…），由 app.mjs 维护；观测脚本不应从这里取账本。 */
export const PROCESS_STATE_DIR = path.join(PROJECT_ROOT, 'qq-bridge', 'state');

/** 观测账本根：所有只读报告、回放、指数都从这里取。 */
export function obsPaths(root = PROJECT_ROOT) {
  const base = path.resolve(root);
  const data = path.join(base, 'data');
  const state = path.join(data, 'state');
  return {
    root: base,
    data,
    state,
    lifeLog: path.join(data, 'logs', 'life-log'),
    memory: path.join(data, 'memory'),
    memoryArchive: path.join(data, 'memory', '_archive'),
    reports: path.join(data, 'reports'),
    alivenessDir: path.join(data, 'reports', 'aliveness'),
    securityAudit: path.join(data, 'reports', 'security-audit.json'),
    actionLog: path.join(state, 'action-log.jsonl'),
    floorDecisions: path.join(state, 'floor-decisions.jsonl'),
    lessons: path.join(state, 'lessons.jsonl'),
    cognition: path.join(state, 'cognition.jsonl'),
    insights: path.join(state, 'insights.jsonl'),
    lessonsLedger: path.join(state, 'mind', 'lessons-ledger.jsonl'),
    people: path.join(state, 'people.json'),
    socialGraph: path.join(state, 'social-graph.json'),
    identityMap: path.join(state, 'mind', 'identity-map.jsonl'),
    styleBaseline: path.join(state, 'mind', 'style-baseline.json'),
    evolution: path.join(state, 'evolution.jsonl'),
    selfState: path.join(state, 'mind', 'self-state.json'),
    beliefs: path.join(state, 'mind', 'beliefs.json'),
    // [LIFE-RECONCILE] S4 影子对账：内核独立态 vs state-hub 真实态
    kernelState: path.join(state, 'mind', 'kernel-state.json'),
    stateHub: path.join(state, 'mind', 'state-hub.json'),
    offlineNarrative: path.join(state, 'mind', 'offline-narrative.json'),
  };
}
