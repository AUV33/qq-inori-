// 会话创建：ensureSession（复用/退役重建/workspace 恢复/策略竞态保护）。
//
// 从 app.mjs 的 main() 搬出（P3-RW-11，2026-10-31）。所有运行期状态经 getter 注入：
// sessionEpoch 会递增、currentMode/cfg/dshPresetIds 会变化，不能冻结快照。
/**
 * @param {object} ctx
 * @param {()=>object} ctx.getState
 * @param {()=>number} ctx.getSessionEpoch
 * @param {()=>object} ctx.getCfg
 * @param {()=>string} ctx.getCurrentMode
 * @param {()=>string[]} ctx.getDshPresetIds
 * @param {(key:string)=>string} ctx.sessionPolicy
 * @param {(key:string)=>boolean} ctx.isSessionAllowedInCurrentMode
 * @param {(key:string,id:string)=>boolean} ctx.isCurrentSession
 * @param {(key:string)=>void} ctx.retireSession
 * @param {(id:string)=>Promise<any>} ctx.ensureChatModel
 * @param {()=>Promise<string>} ctx.ensureHerWorkspace
 * @param {()=>void} ctx.resetHerWorkspace
 * @param {(key:string,mode:string,cfg:object)=>string|undefined} ctx.modePreset
 * @param {object} ctx.api
 * @param {(v:any,label:string)=>any} ctx.unwrap
 * @param {(...args:any[])=>void} ctx.log
 * @param {Map<string,Promise<string>>} ctx.sessionPromises
 * @param {Map<string,string>} ctx.reverse
 * @param {(key:string)=>string} ctx.laneBaseKey
 * @param {()=>void} ctx.saveState
 */
export function createSessionCreate({
  getState, getSessionEpoch, getCfg, getCurrentMode, getDshPresetIds,
  sessionPolicy, isSessionAllowedInCurrentMode, isCurrentSession, retireSession,
  ensureChatModel, ensureHerWorkspace, resetHerWorkspace, modePreset,
  api, unwrap, log, sessionPromises, reverse, laneBaseKey, saveState,
}) {
  async function ensureSession(key) {
    const epoch = getSessionEpoch();
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = getState().sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== getSessionEpoch() || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      let herWsId = await ensureHerWorkspace();
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, getCurrentMode(), getCfg());
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = getCurrentMode() !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = getCurrentMode() === 'reserved2' ? (getCfg().socialV2?.agentPreset || getCfg().agentPreset) : getCfg().agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${getCurrentMode()} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${getDshPresetIds().join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const params = { workspaceId: herWsId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      // [WS-RECOVER] 工作区被用户从 DSH GUI 删掉时，缓存的 workspaceId 会失效；
      // 重建一次工作区并重试，不用等桥接重启。
      if (!sessionId && /workspace|工作区|not.?found|不存在|invalid/i.test(String(lastError?.message ?? ''))) {
        try {
          resetHerWorkspace();
          herWsId = await ensureHerWorkspace();
          const params = { workspaceId: herWsId };
          if (preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create(workspace retry)');
          sessionId = value.sessionId;
          log(`[ws-recover] 工作区已重建，会话 ${key} 重试创建成功`);
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${getCurrentMode()}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== getSessionEpoch() || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-create.mjs:6438'); }
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      getState().sessions[key] = sessionId;
      getState().sessionPolicies[key] = policy;
      reverse.set(sessionId, laneBaseKey(key));
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== getSessionEpoch() || !isCurrentSession(key, sessionId)) {
        if (getState().sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${getCurrentMode()}，preset: ${modePreset(key, getCurrentMode(), getCfg()) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  return { ensureSession };
}
