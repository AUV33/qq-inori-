// life-drive-gate.mjs · 宪章 S4 / C6：切主门禁（纯函数）
//
// 干什么：只有同时满足"影子观察够久 + 对账在容忍带 + 真实 act/memory 端口 + 零未处理错误"
//         才允许 life.mode=drive；否则返回 blockers，由 app 降级为 shadow。
// 为什么：drive 目前只是"另一个名字的 shadow"；若默默接受 drive，迟早有人以为已经接管。
//         切主必须是一个可审计的判定，而不是改一个字符串。
// 输入输出：纯函数；evaluateDriveGate(req) → {allow, requestedMode, effectiveMode, blockers}。
// 失败模式：不抛错；缺数据一律当"未满足"。
// 不做什么：不读文件、不改配置、不启动端口；它只是门禁判定。

export const DRIVE_GATE_VERSION = 1;
export const DRIVE_REQUIREMENTS = Object.freeze({
  minObservationHours: 24,
  maxDriftFields: 0,
  requireActPort: true,
  requireMemoryPort: true,
  requireNoErrors: true,
});

/**
 * @param {{requestedMode?:string, observationHours?:number, reconcile?:{ok?:boolean, reason?:string, drifted?:number}|null,
 *          actReal?:boolean, memoryReal?:boolean, errors?:number}} req
 */
export function evaluateDriveGate(req = {}) {
  const requestedMode = String(req.requestedMode || 'shadow');
  if (requestedMode !== 'drive') {
    return { v: DRIVE_GATE_VERSION, allow: false, requestedMode, effectiveMode: requestedMode, blockers: ['not-drive-requested'], requirements: { ...DRIVE_REQUIREMENTS } };
  }
  const blockers = [];
  const observationHours = Number(req.observationHours) || 0;
  if (observationHours < DRIVE_REQUIREMENTS.minObservationHours) blockers.push(`shadow-observation<${DRIVE_REQUIREMENTS.minObservationHours}h`);
  if (DRIVE_REQUIREMENTS.requireActPort && req.actReal !== true) blockers.push('act-port-not-real');
  if (DRIVE_REQUIREMENTS.requireMemoryPort && req.memoryReal !== true) blockers.push('memory-port-not-real');
  if (DRIVE_REQUIREMENTS.requireNoErrors && (Number(req.errors) || 0) > 0) blockers.push('unhandled-errors>0');
  const reconcile = req.reconcile;
  if (!reconcile || reconcile.reason === 'no-data') blockers.push('reconcile-no-data');
  else {
    if (reconcile.ok !== true) blockers.push(`reconcile-drift:${Number(reconcile.drifted) || 0}`);
    if ((Number(reconcile.drifted) || 0) > DRIVE_REQUIREMENTS.maxDriftFields) blockers.push('reconcile-over-max-drift');
  }
  return {
    v: DRIVE_GATE_VERSION,
    allow: blockers.length === 0,
    requestedMode,
    effectiveMode: blockers.length === 0 ? 'drive' : 'shadow',
    blockers,
    requirements: { ...DRIVE_REQUIREMENTS },
    evidence: { observationHours, actReal: req.actReal === true, memoryReal: req.memoryReal === true, errors: Number(req.errors) || 0, reconcile: reconcile || null },
  };
}

/** 人读一行（启动日志用）。 */
export function formatDriveGate(gate) {
  if (!gate) return 'drive 门禁：无判定';
  if (gate.allow) return 'drive 门禁：通过';
  return `drive 门禁：拒绝（${gate.blockers.join('、')}）→ 降级 ${gate.effectiveMode}`;
}
