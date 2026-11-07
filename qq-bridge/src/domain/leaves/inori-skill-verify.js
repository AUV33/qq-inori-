// inori-skill-verify.js · 技能判据的机器校验（Voyager 式的最小实现）
//
// 技能自带的 verify 目前只是文字。这里把"可机检的写法"变成结构化判据：
//   文件:<路径>    → 路径在允许目录内且存在即算做成（默认 qq-bridge，可注入 allowedRoots）
//   网址:<url>     → 经 safeFetch（SSRF 防护）请求，状态 < 400 即算做成
//   命令:<cmd>     → 一律不执行（技能文本不可信，叶子层不持有命令执行能力），需人工确认
//   其余文字       → 不机检（text），保持原样
// 校验结果挂到技能上：verifyOk / verifyAt / verifyNote，由 record_result 时触发。
// [AUDIT-FIX] 安全边界：url 不再裸 fetch、file 不再接受任意绝对路径、cmd 不再 execFile。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetch } from '../shared/safe-fetch.js';
import { QQ_BRIDGE_DIR } from '../shared/project-paths.js';
// [ENV-REFEREE] 宪章 §5.8：判据从 3 种扩到 6 种（画面/变化/状态）；裁判未接时 ok=null，不假装通过。
import { parseExtendedCriteria, judgeExtendedCriteria } from './skill-criteria.mjs';
// [ATOMIC] 多条判据聚合成 met/not_met/unknown（unknown 不冒充 met）。
import { judgeCriteriaSet } from './action-observe.mjs';

const PREFIX = /^(文件|路径|file)\s*[:：]\s*(.+)$/i;
const URLP = /^(网址|链接|url)\s*[:：]\s*(https?:\/\/\S+)$/i;
const CMD = /^(命令|cmd|command)\s*[:：]\s*(.+)$/i;

/** 解析 verify 文本 → {type:'file'|'url'|'cmd'|'text', target, raw} */
export function parseVerifySpec(verify) {
  const raw = String(verify ?? '').trim();
  if (!raw) return { type: 'text', target: '', raw };
  let m = raw.match(PREFIX);
  if (m) return { type: 'file', target: m[2].trim(), raw };
  m = raw.match(URLP);
  if (m) return { type: 'url', target: m[2].trim(), raw };
  m = raw.match(CMD);
  if (m) return { type: 'cmd', target: m[2].trim(), raw };
  const extended = parseExtendedCriteria(raw);
  if (extended) return { ...extended, raw };
  return { type: 'text', target: '', raw };
}

/**
 * 机检一条判据。
 * @returns {Promise<{ok:boolean|null, type:string, target:string, evidence:string}>} ok=null 表示不机检
 */
export async function checkVerify(verify, {
  // timeoutMs / allowCommand 保留是为了不破坏既有调用点签名；安全收敛后
  // url 用 safeFetch 自带时限、cmd 一律不执行，两者不再影响行为。
  timeoutMs = 5000, allowCommand = false, allowedRoots = [], fetchImpl = safeFetch,
  captureScreen, visionJudge, compareScreens, readState,
} = {}) {
  const spec = parseVerifySpec(verify);
  if (spec.type === 'file') {
    // [AUDIT-FIX] 原本 statSync 接受任意绝对路径，等于让技能文本探测整台机器。
    // 现在限定在 roots 内；roots 可注入，供测试与未来受控目录扩展。
    try {
      // 相对路径按 qq-bridge 目录解析（文档里的 `src/...` 就是这个基准）。
      const resolved = path.resolve(QQ_BRIDGE_DIR, spec.target);
      // realpath 解析目标与其各级父目录，避免符号链接/NTFS junction 绕过字符串前缀判断。
      let real = resolved;
      try { real = fs.realpathSync(resolved); } catch { /* 目标还不存在：用规范化路径 */ }
      const roots = allowedRoots.length ? allowedRoots : [QQ_BRIDGE_DIR];
      const inside = roots.some((root) => {
        let base;
        try { base = fs.realpathSync(path.resolve(root)); } catch { base = path.resolve(root); }
        return real === base || real.startsWith(base + path.sep);
      });
      if (!inside) {
        return { ok: false, type: 'file', target: spec.target, evidence: '路径不在允许目录内，已拒绝' };
      }
      const st = fs.statSync(real);
      return { ok: true, type: 'file', target: spec.target, evidence: st.isDirectory() ? '目录存在' : `文件存在（${st.size} B）` };
    } catch {
      return { ok: false, type: 'file', target: spec.target, evidence: '路径不存在' };
    }
  }
  if (spec.type === 'url') {
    // [AUDIT-FIX] 统一走 safeFetch（DNS 全结果校验 + 已校验 IP 直连 + 每跳复检），
    // 不再用裸 fetch 绕过 SSRF 防护。safeFetch 自带总时限，无需额外 timeoutMs。
    try {
      const r = await fetchImpl(spec.target, 1);
      return { ok: r.statusCode < 400, type: 'url', target: spec.target, evidence: `HTTP ${r.statusCode}` };
    } catch (e) {
      return { ok: false, type: 'url', target: spec.target, evidence: `请求失败：${e?.message ?? e}` };
    }
  }
  if (spec.type === 'cmd') {
    // [AUDIT-FIX] 技能文本属于不可信输入；叶子层不再具备任意命令执行能力。
    // 即使 allowCommand=true 也只记录、不执行——要跑命令请走 owner 侧受审计的适配器。
    return { ok: null, type: 'cmd', target: spec.target, evidence: '命令判据不机检（需人工确认；禁止在叶子层执行）' };
  }
  if (spec.type === 'screen' || spec.type === 'diff' || spec.type === 'state') {
    return judgeExtendedCriteria(spec, { captureScreen, visionJudge, compareScreens, readState });
  }
  return { ok: null, type: 'text', target: '', evidence: '文字判据，无法机检' };
}

/**
 * 多判据聚合：返回 {result, metCount, failedCount, unknownCount, verdicts}。
 * 只用于扩展判据（画面/变化/状态）；文件/网址/命令请逐条 checkVerify。
 */
export async function checkVerifySet(criteria, { captureScreen, visionJudge, compareScreens, readState } = {}) {
  return judgeCriteriaSet(criteria, { captureScreen, visionJudge, compareScreens, readState });
}
