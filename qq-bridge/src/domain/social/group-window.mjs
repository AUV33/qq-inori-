// 只读群窗：她自己的时间里能翻群，但不能发、不能标已读。
//
// 从 app.mjs 的 main() 搬出（P3-RW-12，2026-10-31）。token 存在 social-v2 会话状态里，
// 本模块只读写这一小块；所有会话状态由 app 注入。
import crypto from 'node:crypto';

/**
 * @param {object} ctx
 * @param {(key:string)=>object} ctx.getSocialV2State
 * @param {()=>void} ctx.saveSocialV2State
 * @param {()=>object} ctx.getSocialV2
 * @param {(key:string)=>boolean} ctx.isSessionAllowedInCurrentMode
 */
export function createGroupWindow({ getSocialV2State, saveSocialV2State, getSocialV2, isSessionAllowedInCurrentMode }) {
  // [GROUP-WINDOW] 只读群 token：她自己的时间里能翻群，但不能发、不能标已读。
  function readTokenFor(key) {
    try {
      const st = getSocialV2State(key);
      if (!st.readToken) {
        st.readToken = crypto.randomBytes(18).toString('hex');
        saveSocialV2State();
      }
      return st.readToken;
    } catch { return ''; }
  }

  // [GROUP-WINDOW] 只读 token 校验：只允许读未读/最近，不放过发送。
  function readTokenOkMain(key, token) {
    try {
      if (!token) return false;
      const st = getSocialV2State(key);
      if (!st.readToken) return false;
      const a = Buffer.from(String(token), 'utf8');
      const b = Buffer.from(String(st.readToken), 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  // [GROUP-WINDOW] 给自由时间的「只读群窗」：列出当前模式允许的群 + 只读 token + 未读数。
  function groupReadWindowText() {
    try {
      const rows = [];
      for (const k of getSocialV2().conversations.keys()) {
        if (!String(k).startsWith('group:')) continue;
        if (!isSessionAllowedInCurrentMode(k)) continue;
        const st = getSocialV2State(k);
        const unread = Array.isArray(st.unread) ? st.unread.length : 0;
        rows.push({ k, unread, at: Number(st.lastIncomingAt) || 0, tok: readTokenFor(k) });
      }
      if (!rows.length) return '';
      rows.sort((a, b) => b.at - a.at);
      const lines = rows.slice(0, 3).map((r) => `- ${r.k}（未读 ${r.unread} 条）token=${r.tok}`);
      return [
        '【你自己的群窗（只读）】这些群你可以自己翻开看——只是看：token 只能读，不能发、不能标已读。',
        ...lines,
        '用法：qq_get_unread_messages(key=..., token=..., afterSeq=0) 或 qq_get_recent_messages(key=..., token=...)。',
        '想说话：用 qq_self_wake(key=group:..., wish="去群里说……", inMinutes=0) 把自己叫到那个群；或者等它的下一次唤醒。',
      ].join('\n');
    } catch { return ''; }
  }

  return { readTokenFor, readTokenOkMain, groupReadWindowText };
}
