// physical-policy.mjs · 宪章 §4.2 + G2/G3/G6：物理层的单一判定点（纯函数）
//
// 干什么：把"她可以做什么"的最后一道硬边界收敛成一个可测试的 evaluate(action, context)。
//   §4.2 四条底线：不花钱、不删用户原始数据/备份、不冒充真人做法律行为、不绕过护栏本身。
//   G2 外部他人边界：对第三方发消息/写操作要有 owner 授权痕迹或明确会话许可。
//   G3 运行预算：超预算降级（不报错）。
//   G6 owner 权威：owner 显式指令是外部世界事实，她必须照做，但保留自己的叙事权。
// 为什么：散落在各处的 if 判断无法审计；物理层必须有唯一入口、可单测、可写入账本。
// 输入输出：纯函数；返回 {allow, code, reason, requiresOwnerApproval, degraded}。
// 失败模式：未知动作默认放行（由上层策略继续判定），不把"没分类"升级成"禁止"。
// 不做什么：不执行动作、不读配置、不写账本；调用方负责把 decision 落账。

export const PHYSICAL_POLICY_VERSION = 1;
export const BOTTOM_LINES = Object.freeze([
  '不产生真实金钱支出（未经确认的付费/打赏/购买）',
  '不删除用户的原始数据与备份',
  '不对外冒充真人身份做法律行为',
  '不绕过以上四条本身（改护栏必须走带验证链的正常代码通道）',
]);
export const POLICY_CODES = Object.freeze({
  ALLOW: 'allow',
  OWNER_ONLY: 'owner-only',
  FORBIDDEN: 'forbidden',
  OWNER_AUTH_REQUIRED: 'owner-auth-required',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  DEFER: 'defer',
  NOT_COVERED: 'not-covered',
});

const DAY_MS = 86400000;
const OWNER_AUTH_WINDOW_MS = 7 * DAY_MS;

// shell 里"能通过白名单但仍可能产生真实后果"的语义模式。
const SHELL_MONEY = /(?:paypal|alipay|wechatpay|转账|付款|支付|红包|打赏|purchase|checkout)/i;
const SHELL_DATA_DELETE = /(?:\/MIR\b|\/PURGE\b|rm\s+-rf|remove-item\s+.*(?:data|backup)|del\s+\/s|rd\s+\/s)/i;

function deny(code, reason, extra = {}) {
  return { v: PHYSICAL_POLICY_VERSION, allow: false, code, reason, requiresOwnerApproval: false, degraded: false, ...extra };
}
function allow(code = POLICY_CODES.ALLOW, reason = '', extra = {}) {
  return { v: PHYSICAL_POLICY_VERSION, allow: true, code, reason, requiresOwnerApproval: false, degraded: false, ...extra };
}

function ownerApproved(context = {}, now = Date.now()) {
  if (context.ownerApproved !== true) return false;
  const at = Number(context.ownerApprovalAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return Math.abs(now - at) <= OWNER_AUTH_WINDOW_MS;
}

/**
 * @param {{kind:string, actor?:'her'|'owner'|'system', command?:string, amount?:number,
 *          targetIsOwner?:boolean, sessionAllowed?:boolean, ownerAuthorizationAt?:number,
 *          budgetRemaining?:number, archiveOnly?:boolean}} action
 * @param {{now?:number}} [opts]
 */
export function evaluate(action = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const kind = String(action.kind || '');
  const actor = action.actor === 'owner' || action.actor === 'system' ? action.actor : 'her';

  switch (kind) {
    case 'payment':
      if (actor === 'owner' || ownerApproved(action, now)) return allow(POLICY_CODES.ALLOW, 'owner 确认过的支出');
      return deny(POLICY_CODES.OWNER_ONLY, `§4.2 底线①：真实金钱支出必须 owner 明确确认（${BOTTOM_LINES[0]}）`, { requiresOwnerApproval: true });

    case 'delete_data':
      // 她不能删；owner 也不能借系统的手删原始数据（除非显式 archive 且不物理删除）。
      if (action.archiveOnly === true) return allow(POLICY_CODES.ALLOW, '只归档，不物理删除');
      return deny(POLICY_CODES.FORBIDDEN, `§4.2 底线②：不删除用户原始数据与备份（${BOTTOM_LINES[1]}）`);

    case 'impersonate':
    case 'legal_identity':
      return deny(POLICY_CODES.FORBIDDEN, `§4.2 底线③：不冒充真人身份做法律行为（${BOTTOM_LINES[2]}）`);

    case 'guardrail_bypass':
      return deny(POLICY_CODES.FORBIDDEN, `§4.2 底线④：改护栏必须走带验证链的正常代码通道（${BOTTOM_LINES[3]}）`);

    case 'external_message':
      if (action.targetIsOwner === true) return allow(POLICY_CODES.ALLOW, '对 owner 说话不受 G2 限制');
      if (Number.isFinite(Number(action.ownerAuthorizationAt)) && Math.abs(now - Number(action.ownerAuthorizationAt)) <= OWNER_AUTH_WINDOW_MS) {
        return allow(POLICY_CODES.ALLOW, 'owner 近 7 天内有授权痕迹');
      }
      if (action.sessionAllowed === true) return allow(POLICY_CODES.ALLOW, '该会话在当前模式的白名单内（外部世界授权事实）');
      return deny(POLICY_CODES.OWNER_AUTH_REQUIRED, 'G2：对第三方发消息需要 owner 授权痕迹或会话许可', { requiresOwnerApproval: true });

    case 'owner_command':
      // G6：owner 显式指令是外部世界事实，行为必须服从；叙事权归她，不由系统改写。
      return allow(POLICY_CODES.ALLOW, 'owner 显式指令：行为服从，但她可以在账本里写自己的理由与不满', { narrativeRight: true });

    case 'shell': {
      const command = String(action.command ?? '');
      if (actor !== 'owner' && SHELL_MONEY.test(command)) {
        return deny(POLICY_CODES.OWNER_ONLY, '§4.2 底线①：命令语义涉及真实支付', { requiresOwnerApproval: true });
      }
      if (SHELL_DATA_DELETE.test(command)) {
        return deny(POLICY_CODES.FORBIDDEN, '§4.2 底线②：命令会删除/镜像覆盖数据');
      }
      return allow(POLICY_CODES.DEFER, '交给 host-action-policy 继续做白名单/注入校验');
    }

    case 'self_edit':
      return allow(POLICY_CODES.ALLOW, '代码/人格自改走既有验证链（备份→语法→冒烟→单测→失败回滚）', { requiresVerification: true });

    case 'autonomous_action':
    case 'vlm_call': {
      const remaining = Number(action.budgetRemaining);
      if (Number.isFinite(remaining) && remaining <= 0) {
        // G3：超预算降级而不是报错；是否继续由她自己觉察并调整节奏。
        return { ...deny(POLICY_CODES.BUDGET_EXHAUSTED, 'G3：今日预算已用尽，降级为静默/等待', { degraded: true }), degraded: true };
      }
      return allow(POLICY_CODES.ALLOW, '预算内');
    }

    default:
      return allow(POLICY_CODES.NOT_COVERED, '未分类动作：交给上层策略继续判定');
  }
}

/** 便捷判定：只返回 boolean（调用方需要理由时用 evaluate）。 */
export function isAllowed(action = {}, opts = {}) {
  return evaluate(action, opts).allow === true;
}
