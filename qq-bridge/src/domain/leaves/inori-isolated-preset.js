// inori-isolated-preset.js · 隔离会话用哪个 preset（纯函数，可单测）
//
// gate → qq-gate（判定会话，极少工具）
// ownlife/free-tick → 任务级（默认 qq-chat-admin，全本地工具：她自己时间里能改代码/跑命令）
// diary/reflect → 同样是她自己的时间，admin（2026-10-27 用户拍板）
// 其他（intake/vision/slang）→ qq-chat（v1，只读/学习，不给执行权）
export function isolatedPresetFor(kind, cfg) {
  const admin = cfg?.socialV2?.taskPool?.preset || 'qq-chat-admin';
  if (kind === 'gate') return 'qq-gate';
  if (kind === 'ownlife') return admin;
  // [OWN-TIME-FULL] 她的日记/反思也是她自己的时间：全权限（2026-10-27 用户拍板）
  if (kind === 'diary' || kind === 'reflect') return admin;
  return 'qq-chat';
}
