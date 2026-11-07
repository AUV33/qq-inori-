// inori-aboutself.js · "有人在说我"的本地判定
//
// 为什么用本地规则而不是让模型判断：
//   这条要在**每条群消息**上跑，用模型等于每条都花钱、还慢；
//   而"有没有提到她"本质上是字符串匹配问题，规则足够。
//
// 三类判据：
//   1) alias    别名/称呼（由 config 提供；默认只认「那个 AI」「AI 那位」这类泛称）
//   2) typo     常见错字/谐音（由 config 提供；默认空）
//   3) thirdParty 第三人称议论（"那个 bot 刚才说…"、"她是不是只会复读"）
//
// 2026-10-30 修（群友说「这个ai好像确实可以」，后半句是「我看她的程序都是自己写然后存盘的」——
// **这句确实在说她**，所以「这个 AI」必须继续算；真正要排除的是**明确在聊别人的 AI**）：
//   · 点名（alias/typo）优先：说了名字就是在说她；
//   · 新增负向线索：我的/我家的/别的/自己做的 AI → 不算；
//   · 新增 config `aboutSelf.otherAiNames`：里面别的 AI 的名字（如「示例AI」）出现 → 不算；
//   · 其余判据（含「这个/那个 AI」「她+疑问」）保持原样，不误伤"在说她"的正常场景。
//
// 注意：不要用单字做匹配——常见词会大面积误触发；单字名的常见词排除表见
// wake-trigger.mjs 的 singleCharBlock（可在 config 里按角色配置）。

export const DEFAULTS = {
  enabled: true,
  // 默认不含任何角色名：人格卡在 roles/（不进仓库），别名由 config.socialV2.aboutSelf.aliases 提供。
  aliases: [
    'AI那位', 'AI 那位', 'ai that',
  ],
  // 常见错字/谐音：说明别人在议论她但名字没打对（由使用者在 config 里补，默认空）
  typo: [],
  // 负向线索：明确在说「别人的 AI」（2026-10-30 加）
  notAboutMe: [
    /(我|俺|咱|我们)(家|们|这|那)?的?\s*(ai|机器人|bot|智能体)/i,
    /(另一个|别的|别家|其他|隔壁|另个)[^，。！？\n]{0,4}(ai|机器人|bot|智能体)/i,
    /自己(做|装|写|弄|搭|养)?(的)?\s*(ai|机器人|bot|智能体)/i,
  ],
  // 别的 AI 的名字（数据在 config：socialV2.aboutSelf.otherAiNames，如「示例AI」）
  otherAiNames: [],
  // 第三人称议论：命中即认为"在说她"（保持原口径）
  thirdParty: [
    /那个\s*(bot|机器人|ai|AI)/,
    /这个\s*(bot|机器人|ai|AI)/,
    /她\s*(是不是|怎么|又|怎么又|到底)/,
    /(机器人|bot|AI)\s*(是不是|怎么|又|会|只会|刚才)/,
  ],
};

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

const NO_HIT = { hit: false, kind: '', matched: '' };

/**
 * @returns {{hit:boolean, kind:'alias'|'typo'|'thirdParty'|'', matched:string}}
 */
export function detectAboutSelf(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.enabled === false) return NO_HIT;
  const raw = String(text ?? '');
  if (!raw.trim()) return NO_HIT;
  const flat = norm(raw);

  // 1) 点名优先：说了名字 / 写了错字，就是在说她（哪怕同一句里也在聊别人的 AI）
  for (const a of o.aliases ?? []) {
    const k = norm(a);
    if (k && flat.includes(k)) return { hit: true, kind: 'alias', matched: String(a) };
  }
  for (const t of o.typo ?? []) {
    const k = norm(t);
    if (k && flat.includes(k)) return { hit: true, kind: 'typo', matched: String(t) };
  }

  // 2) 负向线索：明确在聊「别人的 AI」→ 不算在说她
  for (const re of o.notAboutMe ?? []) {
    if (re instanceof RegExp && re.test(raw)) return NO_HIT;
  }
  for (const n of o.otherAiNames ?? []) {
    const k = norm(n);
    if (k && flat.includes(k)) return NO_HIT;
  }

  // 3) 第三人称议论（保持原口径：这个/那个 AI、她+疑问 都仍算）
  for (const re of o.thirdParty ?? []) {
    if (!(re instanceof RegExp)) continue;
    const m = raw.match(re);
    if (m) return { hit: true, kind: 'thirdParty', matched: m[0] };
  }
  return NO_HIT;
}
