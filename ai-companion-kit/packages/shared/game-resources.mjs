// game-resources.mjs · 「她游戏里的家底」账本（纯函数 + 只读文件）
//
// 为什么（2026-10-30）：她进方舟只会做基建，一半原因是手里没有家底——不知道自己有多少理智/龙门币/源石，
// 就谈不上"规划怎么花"。这一层只做**事实陈述**：上次记了多少、什么时候记的、可能变了。
//
// 纪律：
//   1. 只收**数字**和账号标签（account 只是「示例的号」这种标签，不存任何登录凭据）。
//      密码/验证码/token/cookie 类键名直接丢弃；字符串型数值也丢弃 —— 凭据物理上进不来。
//   2. 代码里不写任何游戏名：活动名就是数据文件里的键名。
//   3. 没有数据就返回空串，不硬凑、不造数字。
import fs from 'node:fs';
import { statePath } from './inori-paths.mjs';

/** 账本路径：默认 data/state/game-resources.json，可用 INORI_RESOURCES_FILE 覆盖（测试用）。 */
export const defaultResourcesFile = () => process.env.INORI_RESOURCES_FILE || statePath('game-resources.json');

const SENSITIVE_KEY_RE = /密码|passwd|password|token|验证码|cookie|secret|api[_-]?key|credential/i;

/** 规范成 { account, updatedAt, values: { 名字: 数字 } }；非法输入一律降级为空结构。 */
export function normalizeSnapshot(input) {
  const src = input && typeof input === 'object' ? input : {};
  const account = String(src.account ?? '').trim().slice(0, 40);
  const updatedAt = String(src.updatedAt ?? '').trim();
  const values = {};
  const raw = src.values && typeof src.values === 'object' ? src.values : {};
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k ?? '').trim().slice(0, 12);
    if (!name || SENSITIVE_KEY_RE.test(name)) continue;
    // 严格只收 number：字符串一律丢（手写 JSON 请写数字，别写 "205"——宁可少一条，也不让凭据混进来）
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    values[name] = v;
  }
  return { account, updatedAt, values };
}

/** 读某个活动的账本；文件缺失/坏 JSON/没有这个活动都返回 null。 */
export function readActivityResources(activity, file = defaultResourcesFile()) {
  const name = String(activity || '').trim();
  if (!name) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = j?.[name];
    if (!row || typeof row !== 'object') return null;
    return normalizeSnapshot(row);
  } catch {
    return null;
  }
}

/**
 * 合并更新（她更新账本时用）：只改传进来的值，其余保留；updatedAt 自动写成 now。
 * patch 里只认 number，敏感键照样丢弃。
 */
export function mergeSnapshot(current, patch, { now = Date.now() } = {}) {
  const base = normalizeSnapshot(current);
  const p = patch && typeof patch === 'object' ? patch : {};
  const account = p.account !== undefined ? String(p.account).trim().slice(0, 40) : base.account;
  const values = { ...base.values, ...normalizeSnapshot({ values: p.values }).values };
  return { account, values, updatedAt: new Date(Number(now)).toISOString() };
}

/** 数字展示：12000 → 「1.2 万」；205 → 「205」；小数保留一位。 */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs >= 10000) {
    const w = v / 10000;
    return `${Number.isInteger(w) ? w : w.toFixed(1)} 万`;
  }
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/** 相对时间：「刚才」/「N 分钟前」/「N 小时前」/「N 天前」；没有可解析的时间返回 ''。 */
export function formatAge(updatedAt, now = Date.now()) {
  const ms = Date.parse(String(updatedAt ?? ''));
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Number(now) - ms);
  if (diff < 60_000) return '刚才';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 渲染账本那一行；没有数值返回空串。
 * 例：「上次记的家底（示例的号）：理智 205、龙门币 1.2 万、源石 3。（2 小时前记的，可能变了）」
 */
export function renderResourceLine(snapshot, now = Date.now()) {
  const s = normalizeSnapshot(snapshot);
  const names = Object.keys(s.values);
  if (!names.length) return '';
  const parts = names.slice(0, 6).map((k) => `${k} ${formatNumber(s.values[k])}`);
  const who = s.account ? `（${s.account}）` : '';
  const age = formatAge(s.updatedAt, now);
  return `\n上次记的家底${who}：${parts.join('、')}。${age ? `（${age}记的，可能变了）` : ''}`;
}
