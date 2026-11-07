// 入站社交消息写入：普通消息与拍一拍进 recent/unread，并触发原文/复读/事实/人物档案。
//
// 从 app.mjs 的 main() 搬出（P3-RW-18，2026-10-31）。只改传入的 st 与 app 注入的
// seenForwardIds；所有记忆/人物/追人副作用经 deps 注入。
// [PERCEPTION] 入站先解析指代/动作，结果挂在消息上供后续动作层使用（不改变回复行为）。
import { perceiveInbound } from '../conversation/perception.mjs';
// [GROUP-HEALTH] 消息极性是群气氛的输入；用既有的确定性词表，不额外调模型。
import { polarityOf } from '../leaves/inori-social-graph.js';
/**
 * @param {object} ctx
 */
export function createSocialAppend(ctx) {
  const {
    getSocialV2State, cleanMemberName, cfg, sanitizeForwardId, seenForwardIds,
    truncateText, truncateTextTail, recordRawAndClaims, detectEchoChain, maybeExtractFacts,
    sanitizeFact, extractFacts, noteMember, cancelChaseV2, chaseState, saveSocialV2State,
  } = ctx;
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], meta = {}) {
    const st = getSocialV2State(key);
    // [NAME-CLEAN] 入站名字先洗：彩色昵称的控制码/配色码不能进 recentMessages，
    // 否则群摘要按 12 字截断后只剩「&ÿÒUÐ」这类乱码（2026-10-30 修）。
    const senderName = cleanMemberName(sender) || '某人';
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    // 同一条消息里重复的转发 id 只留一份：它会进提示词，重复只是噪音
    const safeForwardIds = [...new Set((Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean))];
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    // [PERCEPTION] 纯函数；只记录，不据此改变唤不唤醒。
    const perception = perceiveInbound({
      text: String(plainContent ?? textContent),
      kind: String(key).startsWith('group:') ? 'group' : 'private',
      senderId: userId != null ? String(userId) : '',
      senderName,
      ownerId: cfg.ownerQQ != null ? String(cfg.ownerQQ) : '',
      selfId: meta.selfId != null ? String(meta.selfId) : '',
      mentionedIds: Array.isArray(meta.mentionedIds) ? meta.mentionedIds : [],
      quoteTargetIsSelf: !!quoteTargetIsSelf,
    });
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender: senderName,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      tone: polarityOf(String(plainContent ?? textContent)),
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      perception: { addressee: perception.addressee, speechAct: perception.speechAct, ambiguity: perception.ambiguity },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    // 有新消息进来，「安静满窗口」作废，但「本回合已观察过一次」要保留：
    // 她看过那些 newMessages 后的判断不该被下一条消息立刻清掉，否则在活跃群里永远收不了尾。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // [RAW] 原文落盘 + 命中「承诺/偏好/冲突/计划」的写一条 claim 进记忆库
    recordRawAndClaims(key, msg);
    // [ECHO] 复读/加一检测（群聊）：连续相同句 ≥3 或「加一」≥2 时标记，唤醒时提示她可接一句
    detectEchoChain(key, st, msg);
    // [FACTS] 主人私聊：自动提炼稳定事实写进长期记忆
    maybeExtractFacts(key, msg);
    // [GROUP-MEMBERS] 群成员档案：谁是谁、爱不爱发图、接不接她的话
    // [MEMBER-FACTS] 把「我…」的事实改写为听来的中性说法，落到那个人名下
    try {
      const gText = String(sanitizeFact(msg.text || msg.plain || ''));
      const gFacts = String(key).startsWith('group:') && gText
        ? extractFacts(gText).map((c) => {
            return String(c.text || '')
              .replace(/^他的生日是/, '生日是')
              .replace(/^他今年/, '今年')
              .replace(/^他喜欢/, '喜欢')
              .replace(/^他讨厌/, '讨厌')
              .replace(/^他习惯/, '习惯')
              .replace(/^他住在\/在/, '住在')
              .replace(/^可以叫他/, '自称')
              .replace(/^他的家人\/伴侣/, '家里有')
              .replace(/^他常用/, '常用')
              .replace(/^他家里有\/养了/, '家里有')
              .replace(/^他不/, '不')
              .replace(/^他打算/, '打算')
              .replace(/^他目前在/, '目前在')
              .replace(/^他的爱好是/, '爱好是');
          })
        : [];
      noteMember(key, {
        userId: msg.userId,
        name: msg.sender,
        isSelf: !!msg.isSelf,
        hasMedia: !!msg.hasMedia,
        quoteTargetIsSelf: !!msg.quoteTargetIsSelf,
        text: gText,
        at: Number(msg.time) || Date.now(),
        facts: gFacts,
      });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-append.mjs:9923'); }
    // [GROUP-FEEDBACK] 她发言后 5 分钟内有人接话 → 记一次「被接」（只看别人的反应）
    // [GROUP-FB-WINDOW] 计数器按 24h 滚动窗：累计值会稀释近期表现（白天热晚上冷），
    // 过窗整体清零重计；取数统一走 groupFeedbackRate()（注入与 proactivity 共用）
    try {
      if (String(key).startsWith('group:')) {
        const gf = st.groupFeedback;
        if (gf && gf.pendingAt && Date.now() - Number(gf.pendingAt) < 5 * 60 * 1000) {
          if (Date.now() - Number(gf.windowStart || 0) > 24 * 3600000) {
            gf.sent = 0; gf.replied = 0; gf.windowStart = Date.now();
          }
          gf.replied = Number(gf.replied || 0) + 1;
          gf.pendingAt = 0;
          st.groupFeedback = gf;
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-append.mjs:9939'); }
    // [CHASE] 对方说话了 → 停掉挂着的追问，并重置「连续未回」计数
    try {
      cancelChaseV2(key, '对方发来消息');
      const cst = chaseState(st);
      if (cst.unanswered) { cst.unanswered = 0; saveSocialV2State(); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-append.mjs:9945'); }
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // [CHASE] 对方说话了 → 停掉挂着的追问，并重置「连续未回」计数
    try {
      cancelChaseV2(key, '对方发来消息');
      const cst = chaseState(st);
      if (cst.unanswered) { cst.unanswered = 0; saveSocialV2State(); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-append.mjs:9999'); }
    saveSocialV2State();
    return msg;
  }

  // [GROUP-MEMO] 群记忆确定性写入：她说完话后自动记一条"这轮群里在聊什么"。
  // 为什么必须自动：提示词里写"可以顺手记"必然等于 0 次调用（已验证过 qq_memory_append / lesson_write）。
  // 频率：同一群至少间隔 10 分钟，避免刷屏；内容只取最近几条、截断，控制体量。

  return { appendSocialV2Message, appendSocialV2Poke };
}
