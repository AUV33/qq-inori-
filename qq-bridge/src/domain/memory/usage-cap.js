// [P2-3] token 日预算判定（纯函数）。
//
// 规则来自规划 §4 P2-3：「超额只允许聊天、停后台」——日花费达到上限后：
//   · kind=chat 的回合照常放行（聊天是底线，不能把她锁在门外）；
//   · 其余（background 及其它）一律拒绝，调用方必须把拒绝当成失败，不能硬跑。
// cap<=0 表示关闭日闸；spent 取 token 账本当天（本地自然日）的累计花费。

/**
 * @param {{spent?:number, cap?:number, kind?:string}} input
 * @returns {{exceeded:boolean, allowed:boolean, spent:number, cap:number, remaining:number|null, kind:string}}
 */
export function evaluateDailyCap({ spent = 0, cap = 0, kind = 'background' } = {}) {
  const spentNum = Math.max(0, Number(spent) || 0);
  const capNum = Math.max(0, Number(cap) || 0);
  const kindName = String(kind || 'background');
  const exceeded = capNum > 0 && spentNum >= capNum;
  const allowed = !(exceeded && kindName !== 'chat');
  return {
    exceeded,
    allowed,
    spent: spentNum,
    cap: capNum,
    remaining: capNum > 0 ? Math.max(0, capNum - spentNum) : null,
    kind: kindName,
  };
}
