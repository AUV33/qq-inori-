// bridge-source.mjs · 审计用的「桥接源码合集」
//
// 为什么要有它（2026-10-28，清 main() 专项前置）：
//   79 项审计里有 33 个脚本直接 grep `src/bridge.js` 的源码。只要把一段实现搬到
//   `src/xxx.mjs`，这些断言就会变成"功能还在、文件换了"的假红——于是每次重构都得
//   连带改十几个测试，最后只能一块一块慢慢搬。
//   这里给所有源码级断言一个统一入口：bridge.js + 已抽出的运行期模块拼在一起。
//   搬代码时只需要把新模块加进下面的清单，断言不用动。
//
// 纪律：
//   · 清单是**显式**的（不扫全目录）：`src/*.mjs` 里有 session-router 这种还没接线的草案，
//     扫进来会让"bridge 里不该有 X"这类反向断言误判。
//   · 只用于**源码检查**（grep 标记、计数、挂接纪律）；要验证真实行为请 import 模块本身。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** 组成「桥接运行期源码」的文件（顺序固定，便于计数类断言稳定）。 */
export const BRIDGE_SOURCE_FILES = Object.freeze([
  'bridge.js',
  // 2026-10-28：实现整体搬到 app.mjs，bridge.js 只剩入口壳。
  // 任何"搬文件"都要同步这里，否则源码级断言会假红。
  'app.mjs',
  'bootstrap/config.mjs',
  'bootstrap/mode-utils.mjs',
  'bootstrap/fs-utils.mjs',
  'bootstrap/agent-tokens.mjs',
  'bootstrap/runtime-state.mjs',
  'bootstrap/diary-helpers.mjs',
  'bootstrap/life-state.mjs',
  'tool-flags.js',
  'runtime-tasks.mjs',
  'runtime-gate.mjs',
  'wake-prompt.mjs',
  'wake-extra-lines.mjs',
  'voice-service.mjs',
  'unread-state.mjs',
  'image-service.mjs',
  'sticker-service.mjs',
  'send-format.mjs',
  'onebot-transport.mjs',
  'send-service.mjs',
  'session-telemetry.mjs',
  'session-policy.mjs',
  'session-retire.mjs',
  'session-create.mjs',
  'group-window.mjs',
  'social-format.mjs',
  'social-state.mjs',
  'wake-prompt-service.mjs',
  'self-knowledge.mjs',
  'reply-check.mjs',
  'social-append.mjs',
  'group-memory.mjs',
  'group-facts.mjs',
  'social-loop.mjs',
  'pending-service.mjs',
  'digest-service.mjs',
  'busy-watchdog.mjs',
  'social-core.mjs',
  'reflection-service.mjs',
  'live-feedback-service.mjs',
  'ownlife-service.mjs',
  'role-hint.mjs',
  'intake-service.mjs',
  'tool-learning-service.mjs',
  'maintenance-service.mjs',
  'control-room-service.mjs',
  'social-timing-service.mjs',
  'member-lookup-service.mjs',
  'reply-target-service.mjs',
  'social-records-service.mjs',
  'tool-redaction-service.mjs',
  'wake-affect-service.mjs',
  'reasoning-service.mjs',
  'self-context-service.mjs',
  'wake-runtime.mjs',
  'prompt-candidates-service.mjs',
  'snowluma-token-service.mjs',
  'slang-context-service.mjs',
  'isolated-session-service.mjs',
  'transient-session-service.mjs',
  'send-pipeline-service.mjs',
  'media-service.mjs',
  'sticker-pool-service.mjs',
  'memory-organize-service.mjs',
  'slang-learner-runtime.mjs',
  'model-catalog-service.mjs',
  'session-model-service.mjs',
  'ownlife-dispatch-service.mjs',
  'browse-service.mjs',
  'wake-config-service.mjs',
  'mode-refresh-service.mjs',
  'slang-store-service.mjs',
  'snowluma-watchdog-service.mjs',
  'slang-session-lifecycle.mjs',
  'wake-schedule.mjs',
  'wake-sender.mjs',
  'message-intake.mjs',
  'console-server.mjs',
  'mux-bus.mjs',
  'floor-log.mjs',
  'self-tune.mjs',
  'sticker-autocollect.mjs',
  'outgoing-queue.mjs',
  'wake-trigger.mjs',
  'wake-snapshot.mjs',
  'send-guard.mjs',
  'config-check.mjs',
]);

/**
 * 读取桥接运行期的全部源码（拼接）。
 * @param {{files?: string[]}} [options] 覆盖文件清单（测试用）
 * @returns {string}
 */
export function readBridgeSource(options = {}) {
  const files = options.files ?? BRIDGE_SOURCE_FILES;
  // 2026-11-03：模块开始按域分目录（src/domain/<族>/<name>）。清单仍写平铺名，
  // 这里按"src 根 → src/domain/*/"顺序解析，搬文件不用再同步清单。
  const resolveFile = (name) => {
    const direct = path.join(SRC_DIR, name);
    if (fs.existsSync(direct)) return direct;
    const domainDir = path.join(SRC_DIR, 'domain');
    if (!fs.existsSync(domainDir)) return direct;
    for (const sub of fs.readdirSync(domainDir)) {
      const p = path.join(domainDir, sub, name);
      if (fs.existsSync(p)) return p;
    }
    return direct;
  };
  const raw = files
    .map((name) => {
      try { return fs.readFileSync(resolveFile(name), 'utf8'); } catch { return ''; }
    })
    .filter(Boolean)
    .join('\n');
  // 依赖注入改写归一化（2026-10-28）：
  //   main() 搬进 runtime-services.mjs 的函数统一用 `__deps.x` / 形参 `__deps` 注入。
  //   源码级断言关心的是"哪段逻辑挂在哪"，不是注入前缀，所以在这里把前缀剥掉，
  //   让 `function sendNotice(key, text)`、`groupMutedUntil(id)` 这类老断言继续有意义。
  return raw.replace(/__deps, /g, '').replace(/__deps\./g, '');
}

/** 某个模块是否已经加入合集（搬迁后确认用）。 */
export function isCollected(name) {
  return BRIDGE_SOURCE_FILES.includes(name);
}
