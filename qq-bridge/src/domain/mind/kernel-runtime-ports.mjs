// kernel-runtime-ports.mjs · S4b-3：把"读收敛 + 写回收敛"装配成内核端口
//
// 干什么：在 createShadowPorts 之上包两层：
//   state.load  → kernel-state 与 state-hub 的 7 个双写标量叠加（hub 为准，读收敛）
//   state.save  → kernel tick 后的双写标量提案写回 hub（applyKernelProjection；写回收敛）
// 为什么：S4b-2 只收敛了读；若写不回流，kernel 的动作耗能/被回应不会影响真实状态，切主后会漂。
// 输入输出：返回通过 assertPorts 的端口对象；hub 可选（缺省时退化为纯影子）。
// 失败模式：hub 写回失败只记日志（由调用方 log 注入），不阻断内核 tick。
// 不做什么：不改 kernel reducer、不推进 hub 时间（时间仍由 life-loop 的 hub.tick 管）。

import { createShadowPorts } from '../../kernel/ports.mjs';
import { overlayDualFields } from './kernel-state-overlay.mjs';
import { DUAL_FIELDS } from './life-authority.mjs';

export const KERNEL_RUNTIME_PORTS_VERSION = 1;

export function createKernelRuntimePorts(options = {}) {
  const { at = Date.now(), store, hub = null, stateFile = 'kernel-state.json', log = () => {} } = options;
  // 可选真实端口从 options 读（不在形参里展开，避免接线审计把所有可选能力都当必填 ctx）。
  const ports = createShadowPorts({
    at, store, stateFile,
    lifeLog: options.lifeLog,
    sense: options.sense,
    act: options.act,
    memory: options.memory,
  });
  const hubSnapshot = () => {
    try {
      return hub && typeof hub.snapshot === 'function' ? hub.snapshot() : null;
    } catch { return null; }
  };

  const baseLoad = ports.state.load.bind(ports.state);
  ports.state.load = () => overlayDualFields(baseLoad(), hubSnapshot());

  const baseSave = ports.state.save.bind(ports.state);
  ports.state.save = (state) => {
    const saved = baseSave(state);
    try {
      if (hub && typeof hub.applyKernelProjection === 'function') {
        const projection = {};
        for (const field of DUAL_FIELDS) projection[field] = state?.[field];
        const changed = hub.applyKernelProjection(projection, { at: state?.at });
        if (changed && typeof hub.maybeFlush === 'function') {
          // 异步落盘；失败只记日志，不阻塞 tick。
          void Promise.resolve(hub.maybeFlush()).catch((error) => log('[kernel-ports] hub 落盘失败（忽略）: ' + (error?.message ?? error)));
        }
      }
    } catch (error) {
      log('[kernel-ports] 写回 hub 失败（忽略）: ' + (error?.message ?? error));
    }
    return saved;
  };

  return ports;
}
