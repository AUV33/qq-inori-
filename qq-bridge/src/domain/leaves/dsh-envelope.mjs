// dsh-envelope.mjs · DSH 响应信封的纯解包（从 dsh-client 抽出）
//
// 为什么单独成叶子：会话遥测（domain/conversation/session-telemetry）需要 unwrap，
// 但它不该直接依赖适配器（adapters/dsh-client）——那会把领域层绑到 DSH 上。
// 这里只做"结果信封 → 值/异常"的纯转换，没有网络与状态。

/**
 * 解包 DSH 的 `{ result: { ok, value | error } }` 信封。
 * @param {{result:{ok:boolean, value?:any, error?:{code:string,message:string}}}} response
 * @param {string} label 出错时拼进消息的前缀
 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}
