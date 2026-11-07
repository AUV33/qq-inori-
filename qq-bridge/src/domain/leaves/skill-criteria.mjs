// skill-criteria.mjs · 宪章 §5.8：环境裁判的判据扩展（file/url/cmd → +screen/diff/state）
//
// 干什么：把"画面:<期望元素>" / "变化:<有变化|无变化>" / "状态:<区域>=<期望值>" 解析成结构化判据，
//   并通过**注入的裁判**（截屏/对比/读状态/视觉判断）裁决；裁判没接时返回 ok=null，绝不假装通过。
// 为什么：游戏 adb 事故的根因是"动作与结果之间没有可机检判据"——mastery 恒 0、同一套 steps 空转。
//   没有裁判的世界里，任何智能都无法从经验中学会操作。
// 输入输出：纯解析 + 异步裁决（注入依赖）；无 IO、不执行命令、不直接截图。
// 失败模式：缺裁判/缺期望值 → ok=null + evidence 说明；不抛错。
// 不做什么：不实现 adb/视觉模型本身（那是适配器）；不判定文字判据。

export const SKILL_CRITERIA_VERSION = 1;

const SCREEN = /^(画面|截图|screen)\s*[:：]\s*(.+)$/i;
const DIFF = /^(变化|差异|diff)\s*[:：]\s*(.*)$/i;
const STATE = /^(状态|数值|state)\s*[:：]\s*(.+?)(?:\s*[=＝]\s*(.+))?$/i;

/** 解析扩展判据；不是这三类返回 null。 */
export function parseExtendedCriteria(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let m = raw.match(SCREEN);
  if (m) return { v: SKILL_CRITERIA_VERSION, type: 'screen', target: m[2].trim(), expected: m[2].trim(), raw };
  m = raw.match(DIFF);
  if (m) {
    const expected = String(m[2] ?? '').trim() || '有变化';
    return { v: SKILL_CRITERIA_VERSION, type: 'diff', target: '前后画面', expected, raw };
  }
  m = raw.match(STATE);
  if (m) {
    return { v: SKILL_CRITERIA_VERSION, type: 'state', target: String(m[2] ?? '').trim(), expected: String(m[3] ?? '').trim(), raw };
  }
  return null;
}

function sameValue(actual, expected) {
  const a = Number(actual);
  const e = Number(expected);
  if (Number.isFinite(a) && Number.isFinite(e)) return a === e;
  return String(actual ?? '').trim() === String(expected ?? '').trim();
}

/**
 * 裁决扩展判据。裁判通过 judges 注入：
 *   captureScreen() → {hash, path?}          截屏（用于 diff / screen）
 *   visionJudge({shot, expect}) → {met, evidence}  视觉模型判断画面里有没有期望元素
 *   compareScreens({before, after, expect}) → {met, evidence}  前后画面 diff
 *   readState(area) → 数值/字符串              读 UI 区域数值
 * @returns {Promise<{ok:boolean|null, type:string, target:string, evidence:string}>}
 */
export async function judgeExtendedCriteria(spec, judges = {}) {
  if (!spec || typeof spec !== 'object') return { ok: null, type: 'text', target: '', evidence: '空判据' };
  const type = String(spec.type || '');
  const target = String(spec.target || '');
  const expected = String(spec.expected || '');
  try {
    if (type === 'screen') {
      if (typeof judges.visionJudge !== 'function' || typeof judges.captureScreen !== 'function') {
        return { ok: null, type, target, evidence: '未接视觉裁判（需要 captureScreen + visionJudge）' };
      }
      const shot = await judges.captureScreen();
      if (!shot) return { ok: null, type, target, evidence: '截屏失败' };
      const verdict = await judges.visionJudge({ shot, expect: expected });
      // 裁判说“判不了”（met=null/undefined）时是 unknown，不是失败——但也不是通过。
      if (verdict?.met === null || verdict?.met === undefined) {
        return { ok: null, type, target, evidence: String(verdict?.evidence || '视觉裁判无法判定') };
      }
      return { ok: verdict.met === true, type, target, evidence: String(verdict?.evidence || (verdict?.met ? '画面符合' : '画面不符')) };
    }
    if (type === 'diff') {
      const expectChanged = !/无变化|没变|unchanged|same/i.test(expected);
      if (typeof judges.compareScreens === 'function') {
        const before = typeof judges.captureScreen === 'function' ? await judges.captureScreen() : null;
        const after = typeof judges.captureScreen === 'function' ? await judges.captureScreen() : null;
        const verdict = await judges.compareScreens({ before, after, expect: expectChanged });
        if (verdict?.met === null || verdict?.met === undefined) {
          return { ok: null, type, target, evidence: String(verdict?.evidence || '画面 diff 无法判定') };
        }
        return { ok: verdict.met === true, type, target, evidence: String(verdict?.evidence || '') };
      }
      if (typeof judges.captureScreen === 'function') {
        const before = await judges.captureScreen();
        const after = await judges.captureScreen();
        if (!before || !after) return { ok: null, type, target, evidence: '截屏失败' };
        const changed = String(before.hash ?? '') !== String(after.hash ?? '');
        return { ok: expectChanged ? changed : !changed, type, target, evidence: changed ? '前后画面有变化' : '前后画面无变化' };
      }
      return { ok: null, type, target, evidence: '未接画面 diff 裁判（需要 captureScreen 或 compareScreens）' };
    }
    if (type === 'state') {
      if (!expected) return { ok: null, type, target, evidence: '状态判据缺期望值（写成 状态:区域=期望值）' };
      if (typeof judges.readState !== 'function') return { ok: null, type, target, evidence: '未接状态读取裁判（需要 readState）' };
      const actual = await judges.readState(target);
      if (actual === undefined || actual === null) return { ok: null, type, target, evidence: '读不到该区域状态' };
      const met = sameValue(actual, expected);
      return { ok: met, type, target, evidence: `状态=${actual}（期望 ${expected}）` };
    }
    return { ok: null, type, target, evidence: '未知扩展判据' };
  } catch (error) {
    return { ok: false, type, target, evidence: `裁判执行失败：${error?.message ?? error}` };
  }
}
