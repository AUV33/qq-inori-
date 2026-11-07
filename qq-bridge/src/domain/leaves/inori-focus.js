// inori-focus.js · 重点提取（四槽位）：纯逻辑 + 断言
//
// 背景：审计发现她「只抓不学」——流水账抓得到（intake/digest 都在跑），
// 但「他的要求 / 她承诺的 / 没做完的 / 她留意到的」这一层从来没有人压出来，
// 白天注入的只有流水账摘要，所以「把握不住重点」。
//
// 分工（3B 未上线前的退路，3B 上线后本模块的 parse/render 继续复用）：
//   - 反思轮（夜间窗口）的产出文本里加一个【FOCUS】块，四槽位各一行
//   - harness 在反思轮 turn 结束时解析落盘 state/focus.json
//   - 白天每轮唤醒时把【重点】段拼进 prompt（见 bridge.js MEMORY-INJECT 旁路）
//
// 本模块只做纯计算：解析 / 渲染 / 读写 / 有效期判断。

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

const FOCUS_FILE = stateDataPath('focus.json');

/** 四槽位的固定键位（顺序即渲染顺序） */
export const FOCUS_SLOTS = ['requirements', 'promises', 'unfinished', 'noticed'];
export const FOCUS_SLOT_CN = {
  requirements: '他的要求',
  promises: '她承诺的',
  unfinished: '没做完的',
  noticed: '她留意到的',
};

/** 有效期：反思轮每晚跑，白天用昨晚+今早的产出，超过 36h 视为过期 */
export const FOCUS_MAX_AGE_MS = 36 * 3600 * 1000;

/**
 * 从一轮反思产出文本里解析【FOCUS】块。
 * 容错：整段缺失 → null；块内某槽位缺失/写了「无」→ 该槽位省略。
 * @param {string} text 反思轮完整产出
 * @returns {{requirements?:string,promises?:string,unfinished?:string,noticed?:string, raw:string}|null}
 */
export function parseFocusBlock(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('【FOCUS】');
  if (start < 0) return null;
  const rest = text.slice(start);
  const end = rest.indexOf('【/FOCUS】');
  const body = (end >= 0 ? rest.slice(0, end) : rest).replace('【FOCUS】', '').trim();
  if (!body) return null;
  const out = { raw: body };
  for (const m of body.split('\n')) {
    const line = String(m).trim();
    if (!line) continue;
    const at = line.indexOf(':');
    const atFull = line.indexOf('：');
    const sep = (at >= 0 && (atFull < 0 || at < atFull)) ? at : atFull;
    if (sep < 0) continue;
    const key = String(line.slice(0, sep)).trim().replace(/^[【\[]/, '').replace(/[】\]]$/, '').trim();
    const val = String(line.slice(sep + 1)).trim();
    const slot = FOCUS_SLOTS.find((s) => key === s || key === FOCUS_SLOT_CN[s]);
    if (!slot || !val) continue;
    if (/^无$|^无。?$|^-+$/.test(val)) continue; // 「无」视为该槽位空
    out[slot] = val.slice(0, 80);
  }
  if (!FOCUS_SLOTS.some((s) => out[s])) return null; // 四槽全空 → 当没写
  return out;
}

/**
 * 渲染成白天注入用的【重点】段（确定性拼块，不花模型钱）。
 * @returns {string} 空重点时返回 ''
 */
export function renderFocusBlock(focus) {
  const lines = [];
  for (const s of FOCUS_SLOTS) {
    if (focus?.[s]) lines.push(`${FOCUS_SLOT_CN[s]}：${focus[s]}`);
  }
  if (!lines.length) return '';
  return '【今天要对焦的重点】\n' + lines.join('\n') + '\n——回复先看重点段：他在乎的、她答应了没、卡住的，先接这些再聊别的。';
}

/** 读 focus.json；文件缺失/损坏/过期 → null（过期不删文件，只当没有） */
export function loadFocus(file = FOCUS_FILE) {
  try {
    
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Date.parse(String(j?.at || ''));
    if (!Number.isFinite(at)) return null;
    if (Date.now() - at > FOCUS_MAX_AGE_MS) return null;
    return parseFocusBlock(jsonToBlock(j)) || null;
  } catch { return null; }
}

/** 把落盘的 {at, slots:{...}} 还原成 parseFocusBlock 的输入形态（复用同一解析器） */
function jsonToBlock(j) {
  const slots = j?.slots ?? {};
  const lines = FOCUS_SLOTS.filter((s) => slots[s]).map((s) => `${FOCUS_SLOT_CN[s]}:${slots[s]}`);
  return `【FOCUS】\n${lines.join('\n')}\n【/FOCUS】`;
}

/** 落盘（反思轮结束时调用）；返回写入的槽位数 */
export function saveFocusBlock(focus, file = FOCUS_FILE) {
  
  
  const slots = {};
  for (const s of FOCUS_SLOTS) if (focus?.[s]) slots[s] = focus[s];
  if (!Object.keys(slots).length) return 0;
  // 原子写（tmp+rename）：反思轮产物不能因崩溃丢半截
  const r = writeJsonDocument(file, { at: new Date().toISOString(), slots }, { source: 'bridge/focus' });
  if (!r.ok) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), slots }, null, 2) + '\n', 'utf8');
  }
  return Object.keys(slots).length;
}

/* ---------- 断言（node 直接跑本文件时自检） ---------- */
if (process.argv[1] && /inori-focus\.js$/.test(process.argv[1])) {
  const ok = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
  const full = parseFocusBlock('先写经验…\n【FOCUS】\n他的要求:别催我睡觉\n她承诺的:把画补完\n没做完的:问那家店的事\n她留意到的:他最近总在凌晨发消息\n【/FOCUS】\n以上');
  ok(full?.requirements === '别催我睡觉' && full?.noticed === '他最近总在凌晨发消息', '四槽位解析');
  ok(parseFocusBlock('没有块') === null, '无块返回 null');
  const noSlots = parseFocusBlock('【FOCUS】\n他的要求:无\n她承诺的:无\n没做完的:无\n她留意到的:无\n【/FOCUS】');
  ok(noSlots === null, '全「无」视为空');
  ok(renderFocusBlock({ promises: '把画补完', unfinished: '问那家店的事' }).startsWith('【今天要对焦的重点】'), '渲染');
  ok(renderFocusBlock({}) === '', '空渲染为空串');
  ok(saveFocusBlock({ requirements: 'x' }) >= 1, '落盘');
  const loaded = loadFocus();
  ok(loaded?.requirements === 'x', '读回');
  ok(saveFocusBlock({}) === 0, '空块不落盘');
  console.log('inori-focus.js 断言全部通过');
}
