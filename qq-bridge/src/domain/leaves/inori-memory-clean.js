// inori-memory-clean.js · 群摘要的清洗与结构化
//
// 问题：原来是「取最近 8 条消息，每条硬截 36 字，拼成 200 字」。
// 结果群里会存下这种东西：
//   「群里在聊：某甲：... / 某乙:... / 示例甲\n\t\u0007...」
// —— CQ 码、控制字符、纯表情占位、单人刷屏全都进了记忆库，检索时是噪声。
//
// 做法（纯函数）：
//   1. 清洗：去 CQ 码 / 控制字符 / 零宽字符 / 纯占位（[图片] [表情N] [卡片消息] …）
//   2. 过滤：清洗后不足 3 个有效字的行直接丢
//   3. 聚合：同一人连续发言合并成一段，每人最多 2 段
//   4. 去重：完全相同的片段只留一次
//   5. 限长：每人 30 字、整体 240 字，超出用「…」截断

const PLACEHOLDER = /\[(图片|表情\d*|卡片消息|语音|视频|文件|@[^\]]*|CQ:[^\]]*)\]/g;
const CQ_CODE = /\[CQ:[^\]]*\]/g;
// 控制字符 + 零宽 + 私用区（乱码常见落点）+ 替换字符
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\ufeff\ue000-\uf8ff\ufffd]/g;
// [NAME-CLEAN] QQ 彩色昵称/隐形昵称会把控制码和「$/%/& + 拉丁扩展区」的配色码塞进名字：
//   "\n\u000e\u0012\f示例甲\n\t\n\u0007$ÿĀ\u0011\u0010"  → 可读段只有「示例甲」
//   "\n\n\n\b&ÿÒUÐ\n \u0012\u001e示例角色\u0010" → 摘要按 12 字硬截后只剩「&ÿÒUÐ」
// 这里把「控制/格式字符」一并当垃圾：C0/C1、软连字符、韩文填充符、零宽与 bidi 控制、
// 盲文空白、私用区、替换字符。注意不含普通 Latin-1 字母（é/ü 这类名字不能被误伤）。
const NAME_JUNK = /[\u0000-\u001f\u007f-\u009f\u00ad\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\ue000-\uf8ff\ufffd]/g;
const NAME_JUNK_TEST = /[\u0000-\u001f\u007f-\u009f\u00ad\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\ue000-\uf8ff\ufffd]/;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 群成员名字清洗（纯函数）。
 * 普通名字只做保守清理；一旦检测到控制/格式字符（彩色昵称），
 * 就从第一个中日韩字符起保留到结尾（配色码总在名字前后，尾部残留再剥掉）。
 * 没有中文名时退到最后一段 ASCII 单词/数字。
 * @returns {string} 清洗后的名字；全空返回 '某人'
 */
export function cleanMemberName(raw, { max = 24 } = {}) {
  const src = String(raw ?? '');
  if (!src.trim()) return '';
  const dirty = NAME_JUNK_TEST.test(src);
  // 控制码直接删掉（不留空格，避免把「示例丁~喵」变成「示例丁 ~喵」）
  let s = src.replace(NAME_JUNK, '');
  if (dirty) {
    const at = s.search(CJK_CHAR);
    if (at >= 0) {
      // 可读名字从第一个中文字符开始；括号等标点一并保留
      s = s.slice(at).trim();
      // 去掉名字尾部残留的配色码（$ÿĀB / %Ā / &ÿÒUÐ …）
      s = s.replace(/(?:[&$%][^\u3400-\u9fff\s]{1,8})+$/u, '').trim();
    } else {
      const tail = s.match(/[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
      s = tail ? tail[0].trim() : '';
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, Math.max(1, Number(max) || 24)).join('').trim();
  return s || '某人';
}

/** 清洗一行文本 */
export function cleanText(raw) {
  return String(raw ?? '')
    .replace(CQ_CODE, ' ')
    .replace(PLACEHOLDER, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 有效字数（去掉标点后） */
function effectiveLen(s) {
  return String(s).replace(/[\s，。！？、,.!?~～…—\-"'“”‘’()（）]/g, '').length;
}

/**
 * 从 recentMessages 构造群摘要。
 * @returns {{text:string, kept:number, dropped:number, speakers:number}}
 */
export function buildGroupDigest(messages, opts = {}) {
  const maxPerPerson = Math.max(1, Number(opts.maxPerPerson) || 2);
  const perLine = Math.max(8, Number(opts.perLineChars) || 30);
  const totalMax = Math.max(60, Number(opts.totalChars) || 240);

  const rows = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      // [NAME-CLEAN] 先洗名字再截断：彩色昵称的可读段在控制码之后，先 slice 会把名字整段切掉
      who: m?.isSelf ? '我' : cleanMemberName(m?.ownerLabel || m?.sender || '某人', { max: 12 }),
      text: cleanText(m?.plain || m?.text || ''),
      at: Number(m?.time) || 0,
    }))
    .filter((r) => r.text && effectiveLen(r.text) >= 3);

  const dropped = (Array.isArray(messages) ? messages.length : 0) - rows.length;
  if (!rows.length) return { text: '', kept: 0, dropped, speakers: 0 };

  // 同一人连续发言合并
  const merged = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && last.who === r.who) {
      last.text = `${last.text} ${r.text}`;
      last.at = r.at || last.at;
    } else merged.push({ ...r });
  }

  // 每人最多 N 段；去重
  const seen = new Set();
  const perWho = new Map();
  const picked = [];
  for (const r of merged) {
    const n = perWho.get(r.who) || 0;
    if (n >= maxPerPerson) continue;
    const body = r.text.length > perLine ? r.text.slice(0, perLine) + '…' : r.text;
    const key = `${r.who}|${body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    perWho.set(r.who, n + 1);
    picked.push({ who: r.who, body });
  }

  let text = picked.map((p) => `${p.who}：${p.body}`).join(' / ');
  if ([...text].length > totalMax) text = [...text].slice(0, totalMax).join('') + '…';

  return {
    text,
    kept: picked.length,
    dropped,
    speakers: new Set(picked.map((p) => p.who)).size,
  };
}

/** 给摘要加时间窗前缀（可选） */
export function withWindow(text, fromTs, toTs) {
  const hm = (t) => {
    const d = new Date(Number(t) || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  if (!text) return '';
  return `[${hm(fromTs)}–${hm(toTs)}] ${text}`;
}
