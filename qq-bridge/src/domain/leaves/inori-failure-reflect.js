// inori-failure-reflect.js · 失败后的实时反思：能力 vs 策略归因 + 解决追踪 + 可执行建议
//
// 在 inori-failures.js（失败记账/聚合）之上再加一层"想明白"：
//   · explainFailure(text) → {cause,label,kind,fix}   kind=environment|capability|strategy|unknown
//   · resolveFailure(log)   → 同 key+工具在 3 分钟内又成功了，就把最近那条失败标成"已解决"
//   · renderReflectDigest() → 摘要 + 该原因"可以这样试" + 已解决数
//
// 目的：失败时先分清是「环境问题（不是你的错）/能力问题（缺工具/权限）/策略问题（换参数、换顺序）」，
// 再决定重试还是换法；不把环境问题当成自己不行，也不把策略问题当成运气不好。
import { summarizeFailures, classifyFailure } from './inori-failures.js';

const KIND = {
  mute: 'environment',
  network: 'environment',
  model: 'capability',
  auth: 'capability',
  rate: 'environment',
  missing: 'strategy',
  device: 'environment',
  config: 'capability',
  validation: 'strategy',
  unknown: 'unknown',
};

const FIX = {
  mute: '禁言中先别发；等解禁再开口，别反复试。',
  network: '多是临时抖动：等 10–20 秒重试一次，或换个来源（web_fetch↔web_search）。',
  model: '换个会话或缩短上下文再试；不是你的措辞问题。',
  auth: '没权限就别硬试，直接说明你需要什么；能换有权限的路径再换。',
  rate: '等 30 秒以上再试；先做别的，别连续打同一个接口。',
  missing: '先确认路径/编号/名字（列一下或搜一下），再调第二次。',
  device: '先确认设备连着（adb devices/截图）；没连就别猜坐标。',
  config: '这是配置/插件层面的问题，别反复调；记下报错找主人。',
  validation: '先读状态/文档确认参数含义与取值，再按正确顺序调用（比如先读未读再设水位）。',
  unknown: '先看报错里的关键词再决定，别盲目重试。',
};

const KIND_LABEL = { environment: '环境/外部条件', capability: '能力/权限/工具限制', strategy: '策略/参数/顺序', unknown: '暂不好说' };

/** 失败解释：原因 + 是哪类问题 + 可以怎么试。 */
export function explainFailure(text) {
  const c = classifyFailure(text);
  const kind = KIND[c.key] ?? 'unknown';
  return { cause: c.key, label: c.label, kind, kindLabel: KIND_LABEL[kind], fix: FIX[c.key] ?? FIX.unknown };
}

/** 失败被解决了：同 key+工具、3 分钟内最近一条未解决失败 → resolved。 */
export function resolveFailure(log, { key = '', tool = '', at = Date.now(), windowMs = 180_000 } = {}) {
  const evts = (log && log.events) || [];
  for (let i = evts.length - 1; i >= 0; i -= 1) {
    const e = evts[i];
    if (!e || e.resolved) continue;
    if (at - Number(e.at || 0) > windowMs) break;
    if (e.tool && tool && e.tool !== tool) continue;
    if (key && e.key && e.key !== key) continue;
    e.resolved = true;
    e.resolvedAt = at;
    e.tookMs = at - Number(e.at || 0);
    return e;
  }
  return null;
}

/** 唤醒摘要：失败次数 + 归因（带"是不是你的错"）+ 该原因怎么试 + 已解决数。 */
export function renderReflectDigest(log, opts = {}) {
  // [NPE] 还没有失败账本时调用方会传 null/{} —— 直接调 summarizeFailures 会读 log.events 抛错
  if (!log || !Array.isArray(log.events) || !log.events.length) return '';
  const s = summarizeFailures(log, opts);
  if (!s.total) return '';
  const mins = Math.round((opts.windowMs ?? 30 * 60_000) / 60_000);
  const prio = (k) => ({ strategy: 0, environment: 1, capability: 2, unknown: 3 }[KIND[k] ?? 'unknown'] ?? 3);
  // 同次数时优先挑"能动手改"的原因给建议（策略 > 环境 > 能力 > 其他）
  const top = [...s.causes].sort((a, b) => b.n - a.n || prio(a.key) - prio(b.key))[0];
  const causes = s.causes.slice(0, 3).map((c) => `${c.label}×${c.n}`).join('、');
  const tools = s.tools.slice(0, 3).map((t) => `${t.tool}×${t.n}`).join('、');
  const kind = KIND[top?.key] ?? 'unknown';
  const kindNote = kind === 'environment' ? '（环境/外部条件，不是你做错）' : kind === 'capability' ? '（能力/权限限制，别硬扛）' : kind === 'strategy' ? '（策略/参数问题，可以换法）' : '';
  const fix = String(FIX[top?.key] ?? FIX.unknown).replace(/[。；;]+$/, '');
  // 已解决数按窗口内事件自己算（inori-failures 的 summarize 不一定带 resolved）
  const from = (opts.now ?? Date.now()) - (opts.windowMs ?? 30 * 60_000);
  // [NPE] 调用方可能传 null（还没有失败账本时）——原来这里直接读 log.events 会抛错
  const evts = (log && Array.isArray(log.events)) ? log.events : [];
  const resolved = evts.filter((e) => e && Number(e.at) >= from && e.resolved).length;
  const resolvedNote = resolved ? `，已解决 ${resolved}` : '';
  return `最近 ${mins} 分钟失败 ${s.total} 次${resolvedNote}：${causes}${kindNote}${tools ? `（工具：${tools}）` : ''}；可以这样试：${fix}${s.sample ? `；最后一条：${s.sample}` : ''}`;
}

export { KIND, FIX, KIND_LABEL };
