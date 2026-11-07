// secretary.mjs · 群聊「秘书」预判：唤醒前的最后一道语义门
//
// 为什么需要它（2026-10-29 线上投诉：没听懂就插话、乱插话、回话惹人烦）：
//   现在的唤醒判据是启发式（概率/续聊/问到/提到她），它们只回答"像不像"，
//   不回答"这条到底在跟谁说、她此刻接合不合适"。于是她经常在别人对别人的
//   对话里插一句，或者对半句话作答。
//
// 设计参考（只借架构，不引依赖）：
//   · kawayiYokami/astrbot_plugin_angel_heart 的「前台/秘书/助理」三角色：
//     秘书用便宜模型只判"要不要接话"，决定不接就结束，助理（主模型）不会被唤醒。
//   · HaoxiangXia/maibot-jev-gate 的「只在模糊区间调模型」：
//     这里只对"本来就要叫醒她"的候选做一次判读，不对每条消息全量调用。
//
// 2026-10-29 实测：Qwen2.5-3B 在"说话对象"上会瞎猜（把"你看我的多可爱"判成对她），
// 但给足 4 条少样本 + 把问题收敛成"她此刻插话自不自然（should_reply）"后，
// 7 条测试 6 条对、延迟 ~0.5s。所以最终放行只信 should_reply，addressed 只作日志。
//
// 纪律：
//   · 纯函数（prompt/解析/放行判定），零 IO；模型调用由调用方注入。
//   · 判不了（无模型/超时/输出坏）一律放行——不拿故障当理由改变行为。
//   · 只拦"非定向"的唤醒：@/名字/被拍她本人这类明确叫她的，不走这道门。

export const SECRETARY_REASONS = Object.freeze(['question', 'aboutSelf', 'probability', 'continueChat', 'joinTopic']);

export const SECRETARY_DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMs: 5000,
  maxTokens: 96,
  recentLimit: 8,
  msgChars: 80,
});

/** 这个唤醒原因要不要先问一次秘书（定向唤醒不问）。 */
export function shouldConsultSecretary(reason, { enabled = true } = {}) {
  if (!enabled) return false;
  const root = String(reason ?? '').split(':')[0];
  return SECRETARY_REASONS.includes(root);
}

/** 拼给便宜模型的判读 prompt（少样本 + 一行 JSON）。 */
export function buildSecretaryPrompt({ selfName = '', reason = '', sender = '', text = '', recent = [] } = {}, opts = {}) {
  const o = { ...SECRETARY_DEFAULTS, ...opts };
  const lines = (Array.isArray(recent) ? recent : [])
    .filter((m) => m && String(m.text ?? '').trim())
    .slice(-o.recentLimit)
    .map((m) => `- ${String(m.sender || '某人').slice(0, 16)}：${String(m.text).replace(/\s+/g, ' ').slice(0, o.msgChars)}`);
  const who = String(selfName || '她');
  return [
    '你是群聊记录员，只做两个判断，不要解释。',
    `判断1 addressed：这句话的说话对象是「她」（机器人${who}）、「别人」（某个具体群友）、还是「群里」（对全场、没特定对象）。`,
    '判断2 should_reply：她此刻插话是否自然（被叫到/被问到她/全场开放问大家 → true；别人之间对话、跟她无关、纯感叹 → false）。',
    '例：',
    `- “@${who} 在吗” → {"addressed":"她","should_reply":true}`,
    '- “你看我的多可爱” → {"addressed":"别人","should_reply":false}',
    '- “你们谁会修电脑，帮我看看” → {"addressed":"群里","should_reply":true}',
    '- “今天谁值班” → {"addressed":"群里","should_reply":false}',
    '- “笑死” → {"addressed":"群里","should_reply":false}',
    '只输出一行 JSON：{"addressed":"她|别人|群里","should_reply":true|false,"why":"10字内"}',
    reason ? `（这次唤醒原因：${String(reason).slice(0, 40)}）` : '',
    lines.length ? `【最近消息】\n${lines.join('\n')}` : '',
    `【最后一条】${String(sender || '某人').slice(0, 16)}：${String(text || '').replace(/\s+/g, ' ').slice(0, 300)}`,
  ].filter(Boolean).join('\n');
}

/** 抠出 JSON（容忍代码块/前后废话）；字段不合法返回 null。 */
export function parseSecretaryVerdict(raw) {
  const s = String(raw ?? '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  let addressed = String(obj.addressed ?? '').trim();
  if (addressed === '你') addressed = '她';
  const sr = obj.should_reply;
  const shouldReply = sr === true ? true : sr === false ? false : null;
  if (!['她', '别人', '群里'].includes(addressed) || shouldReply == null) return null;
  return {
    addressed,
    topic: String(obj.topic ?? '').slice(0, 24),
    shouldReply,
    why: String(obj.why ?? '').slice(0, 24),
  };
}

/**
 * 秘书的放行判定：
 *   · 判不了（null）→ 放行；
 *   · 模型说 should_reply=false → 拦（这是本道门的主要目的）；
 *   · addressed 只作日志：「别人+true」在实测里对应"开放问大家"这类，按模型判断放行。
 */
export function secretaryAllows(verdict) {
  if (!verdict) return true;
  return verdict.shouldReply !== false;
}
