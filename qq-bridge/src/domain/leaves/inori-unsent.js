// inori-unsent.js · 没发出去的文字（挂心事容器，纯函数，无 IO）
//
// 由来（2026-10-25 用户拍板 a）：reserved2 模式下她的回话文本不会自动发出，
// 只有调了 qq_send_message 才到群里。写过却没发的，10 分钟补发提醒一过期，
// 原来就"遗忘"了 —— 这个容器让它沉底，own-life / 自唤醒时递给她一行。
//
// 纪律：
//   1. 只递事实 + 许可，不催、不派活、不替她判断哪些该发。
//   2. 容量小、期限短：上限 5 条、14 天沉没期（和 wish 容器同一套纪律）。
//   3. 排序按"短句优先"：实证 10-25 夜 26 条 no-send 里 25 条是她 43–122 字的
//      自理旁白（"设回潜水、标到 2433"），唯一真漏发的是 1 字的「好」。
//      容器只有 5 格，按时间先入先出会把真漏发的挤掉，所以短句优先保留、优先展示。
//
// 注意：这里不判断"她到底想不想发" —— 那归她。容器只记事实。

export const MAX_ITEMS = 5;
export const SINK_TTL_MS = 14 * 24 * 3600 * 1000;
export const RENDER_LIMIT = 2;
/** 补发提醒的有效期：过期后不再"提醒她补发"，改为沉底进容器（容器规则另算）。 */
export const SINK_AFTER_MS = 10 * 60 * 1000;
/** 只有短句才进容器：她的旁白普遍 43–122 字，回话普遍 1–10 字（含「继续潜水。」这种 5 字自述，所以仍靠许可兜底）。 */
export const MAX_SINK_CHARS = 40;

const textOf = (i) => String(i?.text ?? '').trim();

/**
 * 单槽提示的过期判定（noSendHint 每会话只有一格）。
 * 返回应该沉底的那条 {text, at}，否则 null——调用方负责沉底并清空槽位。
 * 抽成纯函数是因为桥接里有三个触发点（排空循环、覆盖前抢救、注入失败），规则必须同源。
 */
export function takeExpiredHint(hint, now = Date.now()) {
  const t = textOf(hint);
  if (!t) return null;
  const at = Number(hint?.at) || 0;
  if (!(at > 0)) return null; // 没有时间戳就不敢断言"过期"，宁可留着提醒
  if (now - at <= SINK_AFTER_MS) return null;
  return { text: t, at };
}

/** 短句优先（更像要说出口的话），同长度按沉的先后（新的在前）。 */
export function compareUnsent(a, b) {
  return (textOf(a).length - textOf(b).length)
    || (Number(b?.sinkAt || 0) - Number(a?.sinkAt || 0));
}

/**
 * 把一条"没发出去的文字"沉进容器。就地改 state.items，返回是否真的加了新条目。
 * 同文不重复沉；长句（> MAX_SINK_CHARS，几乎都是她写给自己的操作旁白）不征收；
 * 超过 14 天或超过 5 条时按短句优先淘汰。
 */
export function sinkUnsent(state, { text, at, key } = {}, now = Date.now()) {
  if (!state || typeof state !== 'object') return false;
  const t = String(text ?? '').trim().slice(0, 200);
  if (!t) return false;
  if (t.length > MAX_SINK_CHARS) return false;
  const items = Array.isArray(state.items) ? state.items : [];
  if (items.some((i) => textOf(i) === t)) return false;
  items.push({ text: t, at: Number(at) || now, key: String(key || ''), sinkAt: now });
  const alive = items.filter((i) => now - Number(i?.sinkAt || 0) < SINK_TTL_MS);
  alive.sort(compareUnsent);
  state.items = alive.slice(0, MAX_ITEMS);
  return true;
}

/** 渲染成一行提示；容器空则返回 null（不制造暗示）。 */
export function renderUnsentLine(state, now = Date.now()) {
  const items = (Array.isArray(state?.items) ? state.items : [])
    .filter((i) => textOf(i))
    .filter((i) => now - Number(i?.sinkAt || 0) < SINK_TTL_MS)
    .sort(compareUnsent)
    .slice(0, RENDER_LIMIT);
  if (!items.length) return null;
  const lines = items.map((i) => `- ${i.key ? `（${i.key}）` : ''}「${textOf(i).slice(0, 60)}」`);
  return `【没发出去的文字】你在「只写字、不自动发」的模式里写下、但没调用发送工具的文字，先记在这里：\n${lines.join('\n')}\n`
    + '哪一句本来是想发到群里的、当时漏了，就到那个会话补一句（重新发一遍就行）；本来就只是你自己记的、或者已经过去了，放着不用管。\n\n';
}
