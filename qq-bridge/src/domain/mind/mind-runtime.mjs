// mind-runtime.mjs · 认知运行时装配（从 app.mjs 上帝文件里抽出的一块）
//
// 职责：把「认知地基 groundwork → 状态中枢 state-hub → 设备资源治理 governor」的
// 创建与启动顺序收在一处，app.mjs 只拿结果。失败逐级降级，不阻塞 24/7 启动。
//
// 不做什么：不接消息、不做决策、不写业务逻辑。

import { stateDataPath, projectPath } from '../shared/project-paths.js';
import { createGroundwork } from './groundwork.mjs';
import { createStateHub } from './state-hub.mjs';
import { createResourceGovernor, createDeviceIdleSensor } from '../shared/resource-governor.mjs';
import { setErrorObserver } from '../shared/best-effort.js';

/**
 * @param {{log?:Function, now?:()=>number}} opts
 * @returns {Promise<{groundwork:object, boot:object, stateHub:object|null, governor:object|null}>}
 */
export async function createMindRuntime({ log = () => {}, now = () => Date.now() } = {}) {
  const groundwork = createGroundwork({
    root: stateDataPath('mind'),
    logRoot: projectPath('data', 'logs', 'life-log'),
    // 首次启动从存量人物档案播种；之后由入站接触持续更新。
    peopleFile: stateDataPath('people.json'),
    now,
  });
  const boot = await groundwork.start();

  // [ERROR-OBSERVED] 全进程 436+ 处 best-effort catch 统一在这里写生命线，
  // 单点、节流、best-effort：不重复记账、写失败不影响任何业务。
  try {
    setErrorObserver((event) => groundwork.lifeLog.append(event, { at: now() }));
  } catch (error) { log('[error-observed] 观察者接线失败（忽略）: ' + (error?.message ?? error)); }

  let stateHub = null;
  try {
    stateHub = createStateHub({ store: groundwork.store, now, log });
    stateHub.load();
    log('[state-hub] 状态单一写入者就绪（state-hub.json）');
  } catch (error) {
    stateHub = null;
    log('[state-hub] 初始化失败（回退旧路径）: ' + (error?.message ?? error));
  }

  let governor = null;
  try {
    governor = createResourceGovernor({
      isDeviceBusy: createDeviceIdleSensor({ flagFile: stateDataPath('device-busy.flag') }),
      now,
      log,
    });
    log('[governor] 设备资源治理就绪（busy 时后台让路）');
  } catch (error) {
    governor = null;
    log('[governor] 初始化失败（忽略）: ' + (error?.message ?? error));
  }

  return { groundwork, boot, stateHub, governor };
}
