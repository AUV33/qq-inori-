// qzone-comment-guard.js · 评论去重 + 回评前缀（纯函数，便于测试）
//
// 为什么：QQ 空间评论发出去撤不回，重复评论是最难看的失败模式
// （Maizone 插件就把它列为已知问题）。这里做本地账本：
// 同一条 tid 30 天内评过就不再评；回评用 "@昵称 内容"（空间评论是平铺的，@ 就是回）。
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from '../../shared/inori-paths.mjs';

const MAX_ENTRIES = 500;

export function resolveGuardFile({ stateDir, envDir } = {}) {
  const dir = String(envDir || process.env.QZONE_GUARD_DIR || '').trim()
    || (stateDir && fs.existsSync(stateDir) ? stateDir : '')
    || (fs.existsSync(statePath()) ? statePath() : '')
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.qzone-mcp');
  return path.join(dir, 'qzone-comments.json');
}

export function loadComments(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && j.comments && typeof j.comments === 'object' ? j.comments : {};
  } catch { return {}; }
}

export function saveComments(file, comments) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries = Object.entries(comments || {})
      .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, MAX_ENTRIES);
    const out = Object.fromEntries(entries);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ comments: out }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function findPriorComment(comments, tid, now = Date.now(), maxAgeDays = 30) {
  const row = comments?.[String(tid)];
  if (!row || !row.at) return null;
  const ageMs = now - Number(row.at);
  if (!(ageMs >= 0) || ageMs > maxAgeDays * 24 * 3600 * 1000) return null;
  return { content: String(row.content || ''), at: Number(row.at), ageDays: Math.max(1, Math.round(ageMs / 86400000)) };
}

export function recordComment(comments, tid, content, at = Date.now()) {
  const key = String(tid);
  const prev = comments[key];
  comments[key] = {
    content: String(content || '').slice(0, 200),
    at,
    count: Number(prev?.count || 0) + 1,
  };
  return comments;
}

export function renderReplyContent(content, replyTo) {
  const body = String(content ?? '').trim();
  const who = String(replyTo ?? '').trim();
  if (!body) return '';
  return who ? `@${who} ${body}`.slice(0, 300) : body.slice(0, 300);
}
