// [LAYER-FIX] R4：domain/shared 不得反向依赖业务域（domain/conversation 等）。
//
// 这两个纯函数原先定义在 domain/conversation/forward.js，而同层的
// cq-segments.mjs（shared）需要复用 forwardIdFromData，形成了 shared → conversation
// 的反向依赖，被架构闸门判定为 R4 违规。下沉到 shared 后：
//   · domain/shared/cq-segments.mjs 与它同层互相引用，分层正确；
//   · domain/conversation/forward.js re-export（见该文件），既有调用方零改动；
//   · 实现只有一份，不制造「两处清洗规则漂移」的安全隐患。
//
// 安全原则：forward id 只允许安全字符、长度受限，避免把任意内容当参数传给 OneBot/日志。
// 本模块只做清洗，不访问网络；「id 必须来自当前会话已见消息」的校验由调用方负责。
export function sanitizeForwardId(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  // 仅用于 OneBot JSON 参数：允许常见 QQ 资源 id 字符，拒绝空白/控制字符。
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

// 从单个 forward 消息段 data 中取 id，供 segmentsToText 与 extractForwardIds 共用。
export function forwardIdFromData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}
