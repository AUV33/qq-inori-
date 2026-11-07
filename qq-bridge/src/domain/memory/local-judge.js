// [LOCAL-JUDGE] 用"已有模型"做情绪/意图判读的编排层（不新增任何模型）
// 依据 GitHub 上的三种成熟做法，全部用本机现有资产落地：
//  1) 规则优先（semantic-router 的路由思想：能毫秒判的就不上模型）——规则层在 inori-affect.js
//  2) 少样本示例：bge-m3 召回相似历史 + reranker 精排，把"类似的话当时是什么情绪"当示例（RAG 思路）
//  3) 小模型只判模糊样本（llama-swap 的按需加载/ttl 卸载思想）：Qwen2.5-3B 按需起、闲置退
// 设计纪律：纯函数可单测；模型不可用时静默降级到规则；只输出"假设"，不下诊断。

export const JUDGE_SCHEMA_HINT = '{"affect":"倾诉|发火|试探|玩笑|亲近|平稳","target":"你|别人|自己|无","intent":"12字内","confidence":0~1,"evidence":"原话2~6字"}';

const AFFECTS = new Set(['倾诉', '发火', '试探', '玩笑', '亲近', '平稳']);
const TARGETS = new Set(['你', '别人', '自己', '无']);

/** 从模型原始输出里抠出 JSON（容忍前后废话、代码块、多行） */
export function parseJudgeJson(raw) {
  const s = String(raw || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const affect = String(obj.affect ?? '').trim();
  const target = String(obj.target ?? '').trim();
  const confidence = Number(obj.confidence);
  return {
    affect: AFFECTS.has(affect) ? affect : null,
    target: TARGETS.has(target) ? target : null,
    intent: String(obj.intent ?? '').slice(0, 24),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    evidence: String(obj.evidence ?? '').slice(0, 12),
  };
}

/**
 * 规则 + 模型 的融合：规则置信高就信规则；模型只能在规则"拿不准"时补位。
 * @param {{affect:string, confidence:number, intent?:string, evidence?:string[]}} rule
 * @param {{affect:string|null, target:string|null, confidence:number|null, intent?:string, evidence?:string}} model
 */
export function fuseJudgement(rule, model, { ruleMin = 0.5, modelMin = 0.55 } = {}) {
  const rConf = Number(rule?.confidence) || 0;
  const mConf = Number(model?.confidence) || 0;
  if (rConf >= ruleMin) {
    return { affect: rule.affect, target: null, intent: rule.intent ?? '', confidence: rConf, evidence: (rule.evidence ?? []).slice(0, 2), source: 'rule' };
  }
  if (model?.affect && model.target && mConf >= modelMin) {
    return { affect: model.affect, target: model.target, intent: model.intent ?? '', confidence: mConf, evidence: model.evidence ? [model.evidence] : [], source: 'model' };
  }
  return { affect: rule?.affect ?? '平稳', target: null, intent: rule?.intent ?? '', confidence: Math.max(rConf, mConf), evidence: (rule?.evidence ?? []).slice(0, 2), source: 'none' };
}

/** 该不该动用模型：规则拿不准 + 文本够长 + 没被踩刹车 */
export function shouldJudge(text, rule, { ruleMin = 0.5, minChars = 6 } = {}) {
  const t = String(text || '').trim();
  if (t.length < minChars) return false;
  if ((Number(rule?.confidence) || 0) >= ruleMin) return false;
  return true;
}

/** 拼 3B 的 messages（约束解码由服务端 grammar/JSON 兜底，这里先把话说死） */
export function buildJudgeMessages(text, { examples = [], who = '对方' } = {}) {
  const ex = (examples || []).slice(0, 3);
  const sys = [
    '你是对话情绪判读器。只输出一行 JSON，不要解释。',
    `字段：${JUDGE_SCHEMA_HINT}`,
    '规则：target 指情绪冲谁（对你/对别人/对自己/对事）。带“哈哈/笑死/狗头”的多半是玩笑，别判成发火。',
    '判断不了就 affect=平稳、confidence≤0.4。',
    ex.length ? '参考这些类似的话当时是怎么判的：' : '',
    ...ex.map((e) => `- “${String(e.text || '').slice(0, 40)}” → ${e.affect}${e.target ? `/${e.target}` : ''}`),
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `${who}这句话：${String(text || '').slice(0, 300)}` },
  ];
}

/** 调一次本地 3B 判读；endpoint 不可用返回 null（调用方降级到规则） */
export async function judgeByModel({ baseUrl, model = 'qwen2.5-3b-instruct-q4_k_m', text, examples = [], timeoutMs = 15000, log = () => {} }) {
  if (!baseUrl) return null;
  const t0 = Date.now();
  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: buildJudgeMessages(text, { examples }), temperature: 0, max_tokens: 120 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) { log(`[local-judge] HTTP ${r.status}`); return null; }
    const j = await r.json();
    const parsed = parseJudgeJson(j?.choices?.[0]?.message?.content ?? '');
    if (!parsed) log('[local-judge] 输出解析失败');
    return parsed ? { ...parsed, ms: Date.now() - t0 } : null;
  } catch (error) {
    log(`[local-judge] 调用失败（降级规则）: ${error?.message ?? error}`);
    return null;
  }
}


/**
 * [DIRECTION] 这条消息是冲她说的（@她/引用她）时，target 不可能是"别人"。
 * 实测 3B 会给出"倾诉/别人"这种自相矛盾的标签；这里按事实纠正并把置信度打九折。
 */
export function correctTarget(model, { directed = false } = {}) {
  if (!model || typeof model !== 'object') return model;
  if (!directed) return model;
  const target = String(model.target || '');
  if (target === '你' || target === '自己' || !target) return model;
  const confidence = Number(model.confidence);
  return {
    ...model,
    target: '你',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence * 0.9)) : confidence,
    corrected: true,
  };
}
