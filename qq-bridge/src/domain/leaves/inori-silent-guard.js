// [SILENT-GUARD] 回复侧「连续缺席」软护栏（纯函数；状态在 socialV2 每会话 st 上：
// st.silentStreak / st.silentReminders / st.silentRef，由 bridge.js 维护）。
// 纪律同黑话判定队列、表情包空盒提示：只递事实+许可，不上「必须回复」硬提示
// （[AT-MENTION] 硬块已被明确否决撤除，本模块是它的软替代：让缺席变得可见，
// 开口不开口仍是她的决定——偶尔不回复是合理的，「总是不说话」才需要被看见）。
// 出句条件（全满足）：
//   1. 强触发（拍一拍/@/名字/提问/关键词/议论她）后连续 >=2 个回合没通过工具开口；
//   2. 距上次说话 >=60 分钟（刚说过话=这条不喜欢接，不催）；
//   3. 本连击内已递过 <2 次软提示（不唠叨）。
// 深夜/清晨加「这个点安静着也正常」软化。状态缺失/脏值一律 null，不造暗示。
export function silentGuardLine(st, now = Date.now()) {
  try {
    const streak = Number(st?.silentStreak) || 0;
    if (streak < 2) return null;
    if ((Number(st?.silentReminders) || 0) >= 2) return null; // 已提醒两次，第三次起闭嘴
    let minNote = '';
    const lastSelf = Number(st?.lastAiReplyAt) || 0;
    if (lastSelf > 0) {
      const min = Math.round((now - lastSelf) / 60000);
      if (min < 60) return null; // 60 分钟内还说过话：不催
      minNote = `，距你上次说话已 ${min} 分钟`;
    }
    const hour = new Date(now).getHours();
    const quiet = hour >= 23 || hour < 8 ? '（这个点安静着也正常）' : '';
    return `【安静】你被叫到后连续 ${streak} 次都没开口${minNote}${quiet}。想说句什么也可以——哪怕就一个字；确实没话可说，就继续静着。`;
  } catch { return null; }
}
