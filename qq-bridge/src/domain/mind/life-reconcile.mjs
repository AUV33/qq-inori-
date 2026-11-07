// life-reconcile.mjs · 宪章 S4：内核影子态 ↔ state-hub 真实态的逐字段对账（纯函数）
//
// 干什么：把 kernel-state.json 与 state-hub.json 的同名字段摆在一起，算偏差、给容忍带、出结论。
// 为什么：P1 影子跑了却只看 energy/hunger 两个标量，等于没对账；切主前必须逐字段看见
//         "两套状态到底差在哪"，尤其是 affect/selfTrust/attention 这些宪章核心变量。
// 输入输出：纯函数；compareLifeStates(kernel, hub, opts) → {ok, checked, drifted, missing, fields}。
// 失败模式：任一侧缺数据返回 no-data（不伪造 0）；单字段缺失记 missing，不当作 drift。
// 不做什么：不读盘、不写盘、不改任何状态；脚本负责 IO。

export const LIFE_RECONCILE_VERSION = 1;

export const DEFAULT_TOLERANCES = Object.freeze({
  energy: 0.15,
  socialHunger: 0.20,
  curiosity: 0.25,
  stress: 0.15,
  valence: 0.20,
  mood: 0.15,
  attention: 0.20,
  selfTrust: 0.10,
  affect: 0.20,
});

const AFFECT_KEYS = Object.freeze(['joy', 'sadness', 'anger', 'fear', 'affection']);
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

function fieldStatus(kernelValue, hubValue, tolerance) {
  const k = Number(kernelValue);
  const h = Number(hubValue);
  if (!Number.isFinite(k) || !Number.isFinite(h)) {
    return { kernel: Number.isFinite(k) ? round4(k) : null, hub: Number.isFinite(h) ? round4(h) : null, delta: null, tolerance: round4(tolerance), status: 'missing' };
  }
  const delta = Math.abs(k - h);
  return {
    kernel: round4(k), hub: round4(h), delta: round4(delta), tolerance: round4(tolerance),
    status: delta <= tolerance + 1e-12 ? 'ok' : 'drift',
  };
}

/**
 * @param {object} kernelState  data/state/mind/kernel-state.json
 * @param {object} hubSnapshot  data/state/mind/state-hub.json（或 {self: ...} 包装）
 * @param {{scale?:number, tolerances?:object}} [opts]
 */
export function compareLifeStates(kernelState, hubSnapshot, opts = {}) {
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
  const tolerances = { ...DEFAULT_TOLERANCES, ...(opts.tolerances && typeof opts.tolerances === 'object' ? opts.tolerances : {}) };
  const kernel = kernelState && typeof kernelState === 'object' ? kernelState : null;
  const hubRoot = hubSnapshot && typeof hubSnapshot === 'object' ? hubSnapshot : null;
  const hubSelf = hubRoot && hubRoot.self && typeof hubRoot.self === 'object' ? hubRoot.self : hubRoot;
  if (!kernel || !hubSelf) {
    return { v: LIFE_RECONCILE_VERSION, ok: false, reason: 'no-data', scale, checked: 0, drifted: 0, missing: 0, fields: [] };
  }

  const fields = [];
  for (const key of Object.keys(DEFAULT_TOLERANCES)) {
    if (key === 'affect') continue;
    fields.push({ path: key, ...fieldStatus(kernel[key], hubSelf[key], (tolerances[key] ?? 0) * scale) });
  }
  for (const key of AFFECT_KEYS) {
    fields.push({ path: `affect.${key}`, ...fieldStatus(kernel.affect?.[key], hubSelf.affect?.[key], (tolerances.affect ?? 0.2) * scale) });
  }
  // state-hub 的第六维（curiosity 情绪）在内核里用标量驱动承载，不强行对比；显式标注为 known-missing。
  fields.push({ path: 'affect.curiosity', kernel: null, hub: Number.isFinite(Number(hubSelf.affect?.curiosity)) ? round4(hubSelf.affect.curiosity) : null, delta: null, tolerance: null, status: 'missing' });

  const drifted = fields.filter((f) => f.status === 'drift').length;
  const missing = fields.filter((f) => f.status === 'missing').length;
  const checked = fields.length - missing;
  return {
    v: LIFE_RECONCILE_VERSION,
    ok: drifted === 0,
    reason: drifted === 0 ? 'within-tolerance' : 'drift',
    scale,
    checked,
    drifted,
    missing,
    fields,
  };
}

/** 人读表：✅/❌ 前缀，缺失用 —。脚本直接打印。 */
export function formatReconcileReport(report) {
  if (!report || report.reason === 'no-data') return '对账无数据：需要 kernel-state.json 与 state-hub.json 都存在（先开 life.mode=shadow 跑一轮）。';
  const lines = [];
  lines.push(`对账：${report.checked} 项可比 / ${report.drifted} 项超容忍 / ${report.missing} 项缺失（scale=${report.scale}）`);
  for (const f of report.fields) {
    const mark = f.status === 'ok' ? '✅' : f.status === 'drift' ? '❌' : '—';
    const k = f.kernel == null ? '—' : f.kernel;
    const h = f.hub == null ? '—' : f.hub;
    const d = f.delta == null ? '' : ` Δ${f.delta}`;
    const t = f.tolerance == null ? '' : ` (容忍 ${f.tolerance})`;
    lines.push(`${mark} ${f.path}: kernel=${k} hub=${h}${d}${t}`);
  }
  lines.push(report.ok ? '结论：在容忍带内（可进入 24h 影子观察后的切主评估）。' : '结论：存在超容忍偏差，禁止切主；先查字段来源与单写者。');
  return lines.join('\n');
}
