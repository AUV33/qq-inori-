// QQ → DeepSeek Harness 桥接：入口壳（2026-10-28 拆分）
//
// 为什么分成两个文件：
//   原来的 bridge.js 是一个 18k 行的"入口 + 全部实现"，main() 里塞着 16k 行编排，
//   任何改动都只能整文件回滚。现在入口只负责"启动/兜底"，实现（main 及全部运行时逻辑）
//   在 app.mjs；后续按 HTTP / turn / prompt 逐块从 app.mjs 拆成独立服务。
//
// 纪律：
//   · 本文件只允许出现：import、main() 调用、进程级兜底。不要在这里加业务逻辑。
//   · 启动失败必须 exit(1)，让看门狗拉起；不要在入口吞异常。
//   · 代码位置的迁移要同步 scripts/lib/bridge-source.mjs 的文件清单（审计按合集读源码）。
import { main } from './app.mjs';

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
