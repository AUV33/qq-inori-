// action-observe.mjs · 宪章 §5.8：动作-观察原子化 + 判据集 + 空转熔断
//
// 干什么：把"动作 → 截图/读状态 → 判据"绑成一步：
//   · runAtomicStep：动作与观察必须同时给出，缺一即 invalid（禁止盲操作）；
//   · judgeCriteriaSet：多条判据聚合为 met / not_met / unknown（unknown 绝不冒充 met）；
//   · detectStuck：同一动作签名连续 N 次未 met → 判定空转，交上层熔断。
// 为什么：游戏 adb 事故里，动作与结果之间没有可机检判据，mastery 恒 0、同一套 steps 空转；
//   没有原子化，oneChange 找不到"到底哪一下错了"。
// 输入输出：纯异步编排（依赖注入 action/observe/judges）；不读盘、不调模型、不执行命令。
// 失败模式：动作抛错→结果 failed 且带 evidence；观察缺失→invalid；不假装成功。
// 不做什么：不实现 adb/视觉本身；不决定技能是否该练（那是 L2 欲望与技能层）。

import { parseExtendedCriteria, judgeExtendedCriteria } from './skill-criteria.mjs';

export const ACTION_OBSERVE_VERSION = 1;

/**
 * 手机裁判适配器：把“截图/读屏文字/视觉分类/读状态”包装成 action-observe 的 judges。
 * 不实现 adb 或视觉模型本身；没有对应能力时返回 null（unknown），不猜。
 * @param {{captureScreen?:Function, readText?:Function, classify?:Function, compareScreens?:Function, readState?:Function}} deps
 */
export function createPhoneReferee({ captureScreen, readText, classify, compareScreens, readState } = {}) {
  const capture = typeof captureScreen === 'function' ? captureScreen : null;
  const visionJudge = typeof classify === 'function'
    ? async ({ shot, expect }) => classify({ shot, expect })
    : async ({ shot, expect }) => {
      let text = String(shot?.text ?? '');
      if (!text && typeof readText === 'function') {
        try { text = String(await readText() ?? ''); } catch { text = ''; }
      }
      if (!text) return { met: null, evidence: '无画面文字/无视觉模型' };
      const met = text.includes(String(expect));
      return { met, evidence: met ? '画面文字包含期望' : '画面文字不含期望' };
    };
  return {
    captureScreen: capture,
    visionJudge,
    compareScreens: typeof compareScreens === 'function' ? compareScreens : undefined,
    readState: typeof readState === 'function' ? readState : undefined,
  };
}

/** 解析判据数组：扩展判据（画面/变化/状态）走 skill-criteria；解析不了的进 unknown。 */
export function normalizeCriteria(criteria) {
  return (Array.isArray(criteria) ? criteria : [criteria])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .map((raw) => parseExtendedCriteria(raw) || { v: ACTION_OBSERVE_VERSION, type: 'text', target: '', expected: '', raw });
}

/**
 * 聚合裁决：任何一条 unknown 都不能算 met；全部 met 才是 met；有 failed 就是 not_met。
 * @returns {Promise<{result:'met'|'not_met'|'unknown', metCount:number, failedCount:number, unknownCount:number, verdicts:Array}>}
 */
export async function judgeCriteriaSet(criteria, judges = {}) {
  const specs = normalizeCriteria(criteria);
  if (!specs.length) return { result: 'unknown', metCount: 0, failedCount: 0, unknownCount: 0, verdicts: [] };
  const verdicts = [];
  for (const spec of specs) {
    if (spec.type === 'text') {
      verdicts.push({ ok: null, type: 'text', target: '', evidence: '文字判据无法机检' });
      continue;
    }
    verdicts.push(await judgeExtendedCriteria(spec, judges));
  }
  const metCount = verdicts.filter((v) => v.ok === true).length;
  const failedCount = verdicts.filter((v) => v.ok === false).length;
  const unknownCount = verdicts.filter((v) => v.ok === null).length;
  const result = failedCount > 0 ? 'not_met' : (unknownCount > 0 ? 'unknown' : (metCount === verdicts.length ? 'met' : 'unknown'));
  return { result, metCount, failedCount, unknownCount, verdicts };
}

/**
 * 原子一步：动作 + 观察 + 判据，缺观察就是盲操作。
 * @param {{action:Function, observe:Function, criteria:Array|string, judges?:object, meta?:object}} input
 */
export async function runAtomicStep(input = {}) {
  const { action, observe, criteria, judges = {}, meta = {} } = input;
  if (typeof action !== 'function' || typeof observe !== 'function') {
    return { v: ACTION_OBSERVE_VERSION, ok: false, result: 'invalid', reason: '动作与观察必须同时给出（禁止盲操作）', verdicts: [] };
  }
  let observation = null;
  try {
    await action();
    observation = await observe();
  } catch (error) {
    return { v: ACTION_OBSERVE_VERSION, ok: false, result: 'failed', reason: `动作/观察失败：${error?.message ?? error}`, verdicts: [], meta };
  }
  const judged = await judgeCriteriaSet(criteria, judges);
  return {
    v: ACTION_OBSERVE_VERSION,
    ok: judged.result === 'met',
    result: judged.result,
    observation,
    verdicts: judged.verdicts,
    counts: { met: judged.metCount, failed: judged.failedCount, unknown: judged.unknownCount },
    meta,
  };
}

/**
 * 空转检测：同一签名在窗口内连续 >= maxAttempts 次且没有一次 met → stuck。
 * @param {{attempts:Array<{signature:string, result:string, at:number}>, now?:number, windowMs?:number, maxAttempts?:number}} input
 */
export function detectStuck({ attempts, now = Date.now(), windowMs = 30 * 60 * 1000, maxAttempts = 3 } = {}) {
  const rows = (Array.isArray(attempts) ? attempts : [])
    .filter((a) => a && Number.isFinite(Number(a.at)) && Number(a.at) >= now - windowMs)
    .sort((a, b) => Number(a.at) - Number(b.at));
  if (!rows.length) return { stuck: false, reason: 'no-attempts', signature: '', count: 0 };
  const last = rows[rows.length - 1];
  const same = rows.filter((a) => String(a.signature) === String(last.signature));
  const consecutive = (() => {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (String(rows[i].signature) !== String(last.signature)) break;
      n += 1;
    }
    return n;
  })();
  const met = same.some((a) => String(a.result) === 'met');
  const stuck = !met && consecutive >= Math.max(2, maxAttempts);
  return {
    stuck,
    reason: stuck ? `同一动作连续 ${consecutive} 次未通过判据` : (met ? '已有通过记录' : '未达熔断阈值'),
    signature: String(last.signature || ''),
    count: consecutive,
  };
}
