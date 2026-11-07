// 会话策略：模式/白名单/preset/owner lane/sessionPolicy。
//
// 从 app.mjs 的 main() 搬出（P3-RW-9，2026-10-31）。策略是纯判定，运行时状态全部经 getter 注入：
// currentMode / dshPresetIds / dshDefaultPreset / closedAgentPreset 都会在运行中变化，不能冻结快照。
/**
 * @param {object} ctx
 * @param {()=>object} ctx.getCfg
 * @param {()=>string} ctx.getCurrentMode
 * @param {()=>string[]} ctx.getDshPresetIds
 * @param {()=>string} ctx.getDshDefaultPreset
 * @param {()=>string} ctx.getClosedAgentPreset
 * @param {(kind:string,id:number,cfg:object)=>boolean} ctx.allowed
 * @param {(key:string)=>object} ctx.getSocialV2State
 * @param {object} ctx.state
 * @param {(...args:any[])=>void} ctx.log
 */
export function createSessionPolicy({
  getCfg,
  getCurrentMode,
  getDshPresetIds,
  getDshDefaultPreset,
  getClosedAgentPreset,
  allowed,
  getSocialV2State,
  state,
  log,
}) {
  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (getDshDefaultPreset() || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (getDshPresetIds().length === 0) return strict ? '' : wanted;
    if (getDshPresetIds().includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${getDshPresetIds().join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return getDshDefaultPreset() || '';
  }

  // [PERM-BY-PERSON] lane key：group:xxx#owner 是 owner 在群里的专属会话
  const OWNER_LANE_SUFFIX = '#owner';
  function laneBaseKey(key) {
    const k = String(key ?? '');
    return k.endsWith(OWNER_LANE_SUFFIX) ? k.slice(0, -OWNER_LANE_SUFFIX.length) : k;
  }
  function isOwnerLaneKey(key) {
    return String(key ?? '').endsWith(OWNER_LANE_SUFFIX);
  }
  // 群里「最后一条未读」是 owner 本人、且是 10 分钟内的 → 这一轮按 owner lane 走（全权限）。
  function ownerLaneFor(key) {
    const k = String(key ?? '');
    if (!k.startsWith('group:')) return false;
    const owner = String(getCfg()?.ownerQQ ?? '').trim();
    if (!owner) return false;
    try {
      const st = getSocialV2State(k);
      const unread = Array.isArray(st.unread) ? st.unread.filter((m) => m && !m.isSelf) : [];
      const last = unread[unread.length - 1];
      return !!(last && last.isOwner);
    } catch { return false; }
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(getClosedAgentPreset());
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // [ADMIN-PRESET] 只有 ownerQQ 自己的**私聊**能用 qq-chat-admin（本地命令/读写文件）。
    // 群里的 owner lane 仍然独立上下文（#owner），但绝不挂本地工具：群消息是不可信输入，
    // 一旦挂 admin preset，群友的 prompt injection 就能借主人车道读本机/跑命令。
    // 群里的 owner lane 走普通 qq-chat-v2；需要在群里办事就让主人私聊她。
    const ownerPrivate = (() => {
      const m = /^private:(\d+)$/.exec(String(laneBaseKey(key)));
      const owner = String(getCfg()?.ownerQQ ?? '').trim();
      return !!(m && owner && m[1] === owner);
    })();
    if (mode === 'reserved2' && ownerPrivate) {
      // strict=true：admin preset 不在 DSH 清单时不要回退到 DSH 默认 preset（那会把 bash/文件工具
      // 静默换上），而是落到下面的聊天 preset（qq-chat-v2），与日志里承诺的行为一致。
      const admin = resolvePresetName('qq-chat-admin', { strict: true });
      if (admin) return admin;
      log('⚠️ qq-chat-admin 不在 DSH preset 清单里，退回默认聊天预设（本地工具不会开放）');
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const base = laneBaseKey(key);
    const m = /^(group|private):(\d+)$/.exec(base);
    if (!m) return false;
    return modeAllowed(base, m[1], Number(m[2]), getCfg(), getCurrentMode());
  }

  function sessionPolicy(key) {
    return JSON.stringify([getCurrentMode(), modePreset(key, getCurrentMode(), getCfg()) ?? '', getCurrentMode() === 'closed-agent' ? getCfg().ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  return {
    modeAllowed,
    resolvePresetName,
    laneBaseKey,
    isOwnerLaneKey,
    ownerLaneFor,
    modePreset,
    isSessionAllowedInCurrentMode,
    sessionPolicy,
    isCurrentSession,
  };
}
