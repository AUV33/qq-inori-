# src/onebot · OneBot v11 接入适配层

> 这层只做 OneBot v11 的**接入与传输硬化**，不承载人格、记忆、社交或发送策略。
> 业务决策在 `src/app.mjs` / `src/wake-*.mjs` / `src/inori-*.js`；这里只回答“这条事件要不要进业务层、连接还活着吗”。

## 文件

| 文件 | 职责 | 主要导出 |
|---|---|---|
| `inbound-gate.mjs` | 入站事件形状校验 + message/poke 幂等 | `createInboundGate()`、`pokeDedupeKey()` |
| `heartbeat.mjs` | `meta_event/heartbeat` 看护：超时回调一次，重置/停止/统计 | `createHeartbeatWatch()` |

## 契约

### `createInboundGate(options)`

```js
const gate = createInboundGate({ dedupe: true, maxSeen: 4096, ttlMs: 600_000 });
const result = gate.accept(oneBotMessageEvent);
// { ok: true, deduped: true, key } |
// { ok: false, reason: 'duplicate'|'malformed', ... }
```

- 只接受 `post_type=message`、`message_type=private|group`、有 `self_id/user_id/message` 的事件。
- 幂等键：`self_id:message_type:group_id:message_id`；`message_id=0` 视为无 id，回退 `msg_id/message_seq`。
- 无幂等键时**放行**，不因为缺 id 吞真实消息。
- `acceptKey(key)` 给 poke notice 复用同一张 TTL/LRU 表；`pokeDedupeKey(event)` 只对 `sub_type=poke` 且有时间的事件生成稳定 key。

### `createHeartbeatWatch(options)`

```js
const watch = createHeartbeatWatch({
  timeoutMs: 120_000,
  checkIntervalMs: 30_000,
  isConnected: () => bot.isConnected,
  onTimeout: () => { /* 只回调一次 */ },
});
watch.noteHeartbeat(event.interval);
watch.start();
```

- 只有**真的收到过 heartbeat** 才开始计时；从没收到过就跳过（不误杀不发心跳的实现）。
- 阈值取 `max(timeoutMs, interval×3)`；`timeoutMs=0` 关闭。
- 超时只回调一次并把基准挪到当前时刻；`reset()` 清 `seen/lastHeartbeatAt/lastIntervalMs/lastResult`。
- 连接断开时调用 `reset()`，不跟 SDK 自带重连抢。

## 接线位置

`src/app.mjs`：

- `bot.onPrivateMessage/onGroupMessage` → `inboundGate.accept()`，重复打 `[dedupe]`，畸形打 `[inbound]`。
- `bot.onMetaEvent(heartbeat)` → `heartbeatWatch.noteHeartbeat()` + 刷新 `wsLastOkAt`。
- `bot.on('close')` → `heartbeatWatch.reset()`。
- `oneBotHealth()` → `/api/status.onebot` 的 `{ connected, url, inbound, heartbeat, queue }`。

## 配置

`config.json` 的 `snowluma` 段：

```json
{
  "heartbeatTimeoutMs": 120000,
  "inboundDedupe": { "enabled": true, "ttlMs": 600000, "maxSeen": 4096 }
}
```

- `heartbeatTimeoutMs=0` 关闭看护。
- `inboundDedupe.enabled=false` 只关去重，形状校验保留。

## 测试

```bash
node --test test/test-inbound-gate.test.mjs   # 13 项
node --test test/test-onebot-heartbeat.test.mjs # 8 项
```

## 边界

- **不 import `src/app.mjs`**；不读全局配置、不发 QQ 消息、不写业务状态。
- **不做白名单/模式判断**：那在 `message-intake` / `app`。
- **不解析引用/昵称/媒体**：那在 `message-intake` 的 `segmentsToText`。
- 新增 OneBot 事件类型时，先在这里加形状校验/幂等键，再改 `app` 接线；不要直接在 `app` 里写正则。

## 变更记录

- 2026-10-31：新增入站闸门与心跳看护；随后补 `message_id=0`、`message_sent` 回显、poke 幂等。
  变更记录见各模块文件头注释与提交历史。
