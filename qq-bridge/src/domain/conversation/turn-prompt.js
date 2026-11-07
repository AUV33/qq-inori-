// turn-prompt.js · DSH prompt 与调度 grant 的统一生命周期。

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {unknown[]} input.content
 * @param {string} input.label
 * @param {'chat'|'background'} input.kind
 * @param {boolean} input.useSlot
 * @param {object|null} input.turnGrant
 * @param {(label:string, opts:object)=>Promise<object>} input.acquireTurnSlot
 * @param {(grant:object, sessionId:string)=>boolean} input.bindTurnGrant
 * @param {(grant:object|null)=>boolean} input.releaseTurnGrant
 * @param {(request:object)=>Promise<object>} input.prompt
 */
export async function submitTurnPrompt({
  sessionId,
  content,
  label = '',
  kind = 'background',
  useSlot = true,
  turnGrant = null,
  acquireTurnSlot,
  bindTurnGrant,
  releaseTurnGrant,
  prompt,
}) {
  let grant = turnGrant;
  if (useSlot && !grant) grant = await acquireTurnSlot(label, { kind });
  // [P2] 调度拒绝：token 日预算、后台小时预算丢弃等都会以 rejected/dropped 返回，
  // 这里必须立刻失败——绝不能带着「没有槽位」的 grant 继续投递（那会绕过所有预算）。
  if (grant && (grant.rejected || grant.dropped)) {
    throw new Error(`调度拒绝（${grant.reason || 'rejected'}）：${label}`);
  }
  if (grant && !bindTurnGrant(grant, sessionId)) {
    releaseTurnGrant(grant);
    throw new Error(`无法把调度槽位绑定到会话：${String(sessionId).slice(0, 8)}`);
  }
  try {
    const accepted = await prompt({ sessionId, mode: 'queue', content });
    // 拒绝和直接命令都不会产生 turn/start，不能把 grant 留给租约超时回收。
    if (!accepted?.result?.ok || accepted.result.value?.command) releaseTurnGrant(grant);
    return accepted;
  } catch (error) {
    releaseTurnGrant(grant);
    throw error;
  }
}
