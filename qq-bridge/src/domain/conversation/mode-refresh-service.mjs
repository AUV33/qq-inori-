import path from 'node:path'; // [P3-FIX] refreshMode 用 path.join，搬出 main() 时漏了 import（11-02 启动崩溃根因）
// 模式与 preset 刷新：从 DSH settings 读 qq-mode / agent-presets，回落本地 mode.json。
//
// 从 app.mjs 的 main() 搬出（P3-RW-58，2026-11-01）。currentMode/preset 等可变状态
// 通过 getter/setter 读写，模块本身不持有状态。
/**
 * @param {object} ctx
 */
export function createModeRefresh(ctx) {
  const {
    api, unwrap, cfg, log, STATE_DIR, readJsonSafe, normalizeModeInput, normalizeOwnerQQ,
    setCurrentMode, getDshDefaultPreset, setDshDefaultPreset,
    setClosedAgentPreset, setDshPresetIds,
  } = ctx;
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        setDshDefaultPreset(presetNs.value.default);
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        setCurrentMode(fromDsh);
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          setClosedAgentPreset(localPreset.closedAgentPreset);
        }
        return;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mode-refresh-service.mjs:4186'); }
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) setCurrentMode(fromLocal);
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      setClosedAgentPreset(local.closedAgentPreset);
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      setDshPresetIds(list.map((p) => String(p.id)));
      if (!getDshDefaultPreset()) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) setDshDefaultPreset(String(marked.id));
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }


  return { refreshMode, refreshPresetList };
}
