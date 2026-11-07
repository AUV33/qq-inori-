// 仅声明本项目自定义的全局；node 运行时类型（process / console / Buffer / URL / node:* 模块等）
// 由 @types/node 提供（typecheck CI 步骤会临时安装，不写入 package-lock）。
export {};

declare global {
  var __ignoredCatch: ((error: unknown, where?: string) => void) | undefined;
}
