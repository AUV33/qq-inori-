/**
 * 入站事件闸门：先把形状不对 / 重复的事件挡在业务层之外。
 *
 * 借鉴 dsh-onebot 的 receive + duplicate 设计：
 *   - 只处理 post_type=message 的私聊/群消息；message_sent 回显直接丢；
 *   - 以 (self_id, message_type, group_id, message_id) 为幂等键，TTL 内有界去重；
 *   - message_id 缺失时不猜、不去重，宁可放行也不因为缺 id 吞掉真实消息。
 *
 * 为什么不用内容哈希：同一个人连发两条“哈哈”是两条真实消息，不能算重复。
 * OneBot 的 message_id 才是稳定的幂等键；SnowLuma 重连/事件重放时同一个
 * message_id 会再来一次，没有这层就会重复唤醒、重复回复。
 *
 * 纯逻辑 + 显式时钟：不读文件、不起定时器，离线可测。
 */

const DEFAULTS = Object.freeze({
  maxSeen: 4096,
  ttlMs: 10 * 60 * 1000,
});

function asId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function hasId(value) {
  return asId(value) !== '';
}

/** message_id=0 在部分实现里表示“没有 id”，不能拿它当幂等键，否则整段会话只会过第一条。 */
function usableMessageId(value) {
  const id = asId(value);
  return id !== '' && id !== '0' ? id : '';
}

export function createInboundGate(options = {}) {
  const maxSeen = Number.isSafeInteger(options.maxSeen) && options.maxSeen > 0
    ? options.maxSeen
    : DEFAULTS.maxSeen;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULTS.ttlMs;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const dedupe = options.dedupe !== false;

  const seen = new Map(); // key -> acceptedAt（Map 保持插入序，天然按时间淘汰）
  let accepted = 0;
  let duplicates = 0;
  let malformed = 0;
  let noKeyAccepted = 0; // [OBSERVABILITY] 无幂等键而放行的次数（不猜、不去重，但可观测）

  function prune(nowMs) {
    while (seen.size > 0) {
      const [key, at] = seen.entries().next().value;
      const expired = nowMs - at > ttlMs;
      if (!expired && seen.size <= maxSeen) break;
      seen.delete(key);
    }
  }

  function keyOf(event) {
    const messageId = usableMessageId(event.message_id)
      || usableMessageId(event.msg_id)
      || usableMessageId(event.message_seq);
    if (!messageId) return '';
    const self = asId(event.self_id);
    const conversation = event.message_type === 'group' ? asId(event.group_id) : '-';
    // [DEDUPE-TIME] 把事件时间也放进幂等键：网关重启后 message_id/seq 若从小数重新发号，
    // 10 分钟内的新消息会撞上旧键被当重复丢掉。重放事件的 time 相同，仍然挡得住；
    // 缺失 time 时退化为原键（不因为字段缺失改变语义）。
    const at = asId(event.time);
    return `${self}:${event.message_type}:${conversation}:${messageId}${at ? `:${at}` : ''}`;
  }

  function validate(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return 'event is not an object';
    if (event.post_type === 'message_sent') return 'message_sent echo';
    if (event.post_type !== 'message') return `post_type=${String(event.post_type)}`;
    if (event.message_type !== 'private' && event.message_type !== 'group') {
      return `message_type=${String(event.message_type)}`;
    }
    if (!hasId(event.self_id)) return 'missing self_id';
    if (!hasId(event.user_id)) return 'missing user_id';
    if (event.message_type === 'group' && !hasId(event.group_id)) return 'missing group_id';
    if (!Array.isArray(event.message) && typeof event.message !== 'string') return 'missing message';
    // [F18] 消息内容 schema 校验：array 形式的 message 是 OneBot 的 segment 列表，
    // 每个 segment 必须是 {type:string, data?:object}。畸形 segment（缺 type、data 类型不对）
    // 直接判 malformed 挡在业务层之外，避免往下流进 segmentsToText/extractMediaFromSegments。
    if (Array.isArray(event.message)) {
      for (const seg of event.message) {
        if (!seg || typeof seg !== 'object' || typeof seg.type !== 'string') return 'invalid message segment';
        if (seg.data !== undefined && (typeof seg.data !== 'object' || seg.data === null || Array.isArray(seg.data))) {
          return 'invalid message segment data';
        }
      }
    }
    return '';
  }

  function remember(key, nowMs) {
    if (!key || !dedupe) {
      // 没有幂等键（或显式关闭去重）：无法判断重复，但不阻断。
      // 不能用内容哈希兜底：同一个人连发两条「哈哈」是两条真实消息，哈希会把第二条吞掉。
      // 这里只计数，让控制台能看出「有多少消息没被幂等保护」，不改变放行行为。
      if (!key) noKeyAccepted += 1;
      prune(nowMs); // 即使本次不去重，也顺带淘汰过期项（dedupe 可运行时切换/复用同一张表时不会滞留）
      accepted += 1;
      return { ok: true, deduped: false };
    }

    prune(nowMs);
    const previousAt = seen.get(key);
    if (previousAt !== undefined) {
      duplicates += 1;
      return { ok: false, reason: 'duplicate', key, previousAt, ageMs: nowMs - previousAt };
    }

    seen.set(key, nowMs);
    prune(nowMs); // 插入后可能超过 maxSeen：再淘汰一次最旧的
    accepted += 1;
    return { ok: true, deduped: true, key };
  }

  /**
   * @param {object} event OneBot v11 事件
   * @returns {{ok:true, deduped:boolean, key?:string} | {ok:false, reason:'malformed'|'duplicate', detail?:string, key?:string, previousAt?:number, ageMs?:number}}
   */
  function accept(event) {
    const problem = validate(event);
    if (problem) {
      malformed += 1;
      return { ok: false, reason: 'malformed', detail: problem };
    }
    return remember(keyOf(event), now());
  }

  /**
   * 非 message 事件（目前是 poke notice）复用同一张 TTL/LRU 表。
   * 调用方负责组成稳定、带时间的 key；没有 key 时按“无法去重”放行。
   */
  function acceptKey(key, nowMs = now()) {
    return remember(String(key ?? '').trim(), nowMs);
  }

  return {
    accept,
    acceptKey,
    clear() {
      seen.clear();
    },
    stats() {
      return { size: seen.size, accepted, duplicates, malformed, noKeyAccepted, maxSeen, ttlMs };
    },
  };
}

/**
 * poke notice 的稳定幂等键：同一个 self/群/人/目标/时间/动作只算一次。
 * 没有 time 的 notice 无法区分两次真实拍一拍，返回空串让调用方放行。
 */
export function pokeDedupeKey(event) {
  if (!event || event.sub_type !== 'poke') return '';
  const time = event.time;
  if (time === undefined || time === null || String(time) === '') return '';
  return [
    'notice',
    event.self_id,
    event.notice_type,
    event.sub_type,
    time,
    event.group_id ?? '-',
    event.sender_id ?? event.user_id ?? '-',
    event.target_id ?? '-',
    event.action ?? '',
    event.suffix ?? '',
  ].map((part) => String(part ?? '')).join(':');
}

export { DEFAULTS as INBOUND_GATE_DEFAULTS };
