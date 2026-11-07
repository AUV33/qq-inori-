// mcp-reserved2-tools.js · 从 mcp-snowluma-safe.js 抽出的「二代仿真模式（reserved2）」工具组（2026-11 拆分）。
// 本模块不创建 server：接收「已带门禁包装器（server.tool 重写）」的 server 实例 + 启动期 cfg 快照，
// 行为与原文件内联注册完全一致。server / cfg 由调用方传入，避免复制模块级状态。
import { z } from 'zod';
import { SENSITIVE_RE } from './domain/shared/sensitive.js';
import { serializeModelData } from './domain/persona/qq-model-view.js';
import { renderCatalog, renderCategory } from './domain/persona/tool-catalog.js';
import { TOOL_CONFIG_FLAGS } from './domain/shared/tool-flags.js';
import { ME_SECTION_IDS, sectionsFor, renderMeView } from './domain/persona/self-view.js';
import { quantStatus, quantQuote, quantKlines, quantBacktest, quantJournal, quantNote, quantBuy, quantSell } from './quant/agent.js';
import { loadConfig, getConfig, getOneBotConfig, isAllowed, unquoteJsonString, onebot, agentApiBase, readConsoleToken, errText, apiErrorText, agentApi } from './mcp-helpers.js';

export function registerReserved2Tools(server, cfg) {
// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。自己时间里的「群窗」给的是只读 token（只能看，不能发/不能标已读）；群唤醒里给的是完整 token。大量积压时用 afterSeq=readThroughSeq 从水位后补读，从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。收尾看你的判断，不看安静时长：话题跟你没关系、你插不上话，把最新消息看完就可以直接 mark_read 收尾，不用等谁安静。若被拒（preSleepBlocked），返回的 unseenCount 是你还没看过的条数——先看完再说。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍你本人时会唤醒你（拍别人不会叫醒你）。收尾看你的判断，不看安静时长：话题跟你没关系、你插不上话，把最新消息看完就可以直接设置潜水，不用等谁安静。若被拒（preSleepBlocked），返回的 unseenCount 是你还没看过的条数——先看完再说。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍你时唤醒（只算拍你本人；拍别人不会叫醒你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '【已合并】这个工具已并入 qq_send_message（当前会话）或 qq_send_to（指定会话）；保留只为兼容旧习惯，新写法请用那两个。 在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-reserved2-tools.js:682'); }
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-reserved2-tools.js:689'); }
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_scene_send',
  '中控台跨场景发话：替她在另一个会话（别的群/别的私聊）里发一句话。**只在主人私聊会话里可用**——群聊或别人的私聊都用不了（防止群友遥控她往别处发消息）。发之前先确认那条消息值得她去别处开口；一次一句，别刷屏。',
  {
    token: z.string().describe('当前会话令牌（见唤醒提示中的【会话令牌】；必须来自主人私聊会话）'),
    key: z.string().describe('要发去哪个会话：group:群号 或 private:QQ号'),
    text: z.string().describe('要发的话（单条 ≤400 字；分条请分开调用）')
  },
  async ({ token, key, text }) => {
    try {
      const data = await agentApi('/api/socialV2/scene-send', {
        method: 'POST',
        body: JSON.stringify({ key, text }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      let msg = errText(error);
      if (!msg || msg === '[object Object]') {
        try { msg = JSON.stringify({ name: error?.name, message: error?.message, code: error?.code }).slice(0, 300); } catch { msg = String(error); }
      }
      return { content: [{ type: 'text', text: `跨场景发话失败：${msg}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。 想给这句话顺手配一张表情就传 stickerId（清单里的短引用 [a1b2c3d4] 就传 a1b2c3d4，或用 qq_list_stickers 的 id/md5/url）或 stickerQuery（按情绪/场景挑一张，如「无语」「笑死」）：桥接会先把文字发成一条气泡、再单独把这张表情发出去，一次调用完成，不用你再分两次。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）'),
    stickerId: z.string().optional().describe('可选：配一张表情（短引用/ id / md5 / url）；桥接先发文字再单独发这张，一次调用完成'),
    stickerQuery: z.string().optional().describe('可选：按情绪/场景挑一张表情（如「无语」「笑死」「安慰」），命中多张随机一张；与 stickerId 二选一')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps, stickerId, stickerQuery }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-reserved2-tools.js:756'); }
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-reserved2-tools.js:763'); }
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps, stickerId: stickerId || undefined, stickerQuery: stickerQuery || undefined }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_to',
  '给「某个指定会话」发消息（不是当前会话就用它）：kind=group 时 id 是群号，kind=private 时 id 是 QQ 号；可带 replyToMessageId 引用。当前会话请用 qq_send_message（更全：多条/间隔/@）。目标必须命中白名单；reserved2 下要带会话令牌 token。不要在发送后输出“已发送”类汇报。',
  {
    kind: z.enum(['group', 'private']).describe('发到群还是私聊'),
    id: z.union([z.number(), z.string()]).describe('群号或 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填，缺令牌会被桥接拒绝）')
  },
  async ({ kind, id, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const isGroup = kind === 'group';
      const endpoint = isGroup ? (replyToMessageId ? '/api/send/reply' : '/api/send/group') : '/api/send/private';
      const body = isGroup
        ? { groupId: String(id), message: cleanMessage, replyToMessageId, token: token || undefined }
        : { userId: String(id), message: cleanMessage, replyToMessageId, token: token || undefined };
      const data = await agentApi(endpoint, {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify(body)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${errText(error)}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。reply：回复前确认有没有补充——按最后来信补足 quietMs，安静够就立即返回，新消息重算静默。messages（默认）：等对方继续说/等回复/看新消息；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs。静默下限后台配置（默认 10000ms）。返回带 newMessages/unreadCount/readThroughSeq/unseenCount，无需重复查询。它不是收尾的门槛：收尾只看你自己的判断（插不上话/话题跟你无关），把消息看完就能直接收，不用等安静；报「已有一个等待中」按提示秒数退避，别连续重试；等得越久新消息被压得越久，别拿它当陪聊。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/收尾前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予收尾前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 120000（硬封顶 180s）；reply 达到静默即返回，不必等满；收尾前观察用 messages，单次最多 60000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        // [WAIT-CAP] 单次等待 HTTP 预算封顶 180s（原来最长 725s：一次调用能把回合占到 12 分钟）
        timeoutMs: Math.min(180000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      // [ERR-DEEP] 错误可能是 {error:{message}} / 字符串化 JSON，逐层扒成人话（之前显示 [object Object]）
      const deepMsg = (() => {
        const dig = (v, depth = 0) => {
          if (v == null || depth > 4) return '';
          if (typeof v === 'string') {
            const t = v.trim();
            if ((t.startsWith('{') || t.startsWith('[')) && t.length < 4000) { try { return dig(JSON.parse(t), depth + 1); } catch { return t; } }
            return t;
          }
          if (typeof v !== 'object') return String(v);
          for (const key of ['message', 'error', 'errorText', 'reason', 'detail', 'text', 'cause']) {
            const got = dig(v[key], depth + 1);
            if (got) return got;
          }
          try { return JSON.stringify(v).slice(0, 200); } catch { return ''; }
        };
        return dig(error);
      })();
      let msg = apiErrorText(errText(error)) || deepMsg;
      if (!msg || msg === '[object Object]') {
        try { msg = JSON.stringify({ name: error?.name, message: error?.message, code: error?.code }).slice(0, 300); } catch { msg = String(error); }
      }
      if (/abort|timeout|超时|掐断|timed out|AbortError/i.test(msg)) {
        return { content: [{ type: 'text', text: '等待超时：没有新消息（被客户端掐断）。换个更短的 timeoutMs 继续等即可；不必马上重试，等有新消息或该收尾时再调用。' }] };
      }
      return { content: [{ type: 'text', text: `等待失败：${msg}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${errText(error)}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.memory !== false) {
  server.tool(
    'qq_cognition_add',
    '把你想明白的一件事沉淀成一条认知（跨事件都成立的判断，不是复述发生过什么）。例如「他在意的是我有没有自己动手，不是结果对不对」「群里冷场时先接梗再接话比直接问问题好使」。一次只写一条；跟已有的认知是同一件事时会被合并更新。写的时候顺手想三件事：这是关于谁的/什么的（kind）、什么情况下才成立（when）、什么时候不成立（unless）——光有一句结论，下次就容易被自己用错。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      concept: z.string().optional().describe('一句话概念（可省略，省略时只用 gist）'),
      gist: z.string().optional().describe('展开一句：这条认知说的是什么'),
      subject: z.string().optional().describe('这条认知说的是哪个主体（人/事/现象），同一主体只留一条有效判断；不填就从句首推'),
      kind: z.enum(['about-him', 'about-group', 'about-world', 'about-me', 'general']).optional().describe('关于他 / 关于群 / 关于世界 / 关于我 / 其他（操作步骤不要写进认知）'),
      when: z.string().optional().describe('什么情况下成立（适用条件），必填，一句话'),
      unless: z.string().optional().describe('什么情况下不成立（例外/反例），可省略'),
      supersedes: z.string().optional().describe('如果这条替换了以前的某条认知，填那条的 id（旧条会标失效，不删）'),
      evidence: z.array(z.string()).optional().describe('你是凭什么想明白的：哪条经验、哪件事，如 ["lesson:手机游戏要先算好坐标再连发"]'),
      confidence: z.number().optional().describe('有多大把握，0~1；刚想明白的给 0.5 左右，被印证过再上调'),
      tags: z.array(z.string()).optional().describe('可选标签，如 [他, 群聊, 学习]'),
      source: z.string().optional().describe('来源：reflect/lesson/browse/she，默认 she')
    },
    async ({ key, token, concept, gist, subject, kind, when, unless, supersedes, evidence, confidence, tags, source }) => {
      try {
        const data = await agentApi('/api/socialV2/cognition', {
          method: 'POST',
          body: JSON.stringify({
            key,
            concept: concept || '',
            gist: gist || '',
            subject: subject || '',
            kind: kind || '',
            when: when || '',
            unless: unless || '',
            supersedes: supersedes || '',
            evidence: evidence || [],
            confidence: confidence == null ? null : Number(confidence),
            tags: tags || [],
            source: source || 'she'
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记认知失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.memory !== false) {
  server.tool(
    'qq_cognition_update',
    '你以前记下的一条认知，现在觉得它更对了、或者不对了，用这个改它。dir=up 是「又被印证了一次」，dir=down 是「这次不成立」——推翻累计三次，这条就自动不再用了（原文留着，不会消失）。如果整条都过时了、你想彻底作废，用 op=supersede 并写一句为什么。不知道 id 就先 qq_cognition_list 翻一下。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('要改的那条认知的 id'),
      op: z.enum(['confirm', 'supersede']).optional().describe('confirm=打分（默认），supersede=整条作废'),
      dir: z.enum(['up', 'down']).optional().describe('op=confirm 时用：up=印证，down=这次不成立'),
      reason: z.string().optional().describe('op=supersede 时用：为什么作废它')
    },
    async ({ key, token, id, op, dir, reason }) => {
      try {
        const data = await agentApi('/api/socialV2/cognition', {
          method: 'POST',
          body: JSON.stringify({ key, id, op: op || 'confirm', dir: dir || 'up', reason: reason || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改认知失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.memory !== false) {
  server.tool(
    'qq_cognition_list',
    '翻你攒下的认知（跨事件都成立的那些判断）。给 query 就按相关度挑，不给就列最近的。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('想看哪方面的认知（可省略）'),
      limit: z.union([z.number(), z.string()]).optional().describe('最多几条，默认 8')
    },
    async ({ key, token, query, limit }) => {
      try {
        const qs = new URLSearchParams({ key: String(key) });
        if (query) qs.set('query', String(query));
        if (limit) qs.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/cognition?${qs.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `翻认知失败：${errText(error)}` }], isError: true };
      }
    }
  );
}
server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象；fact=长期事实（比如某个人的生日、定下来的规矩、稳定的偏好）。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。fact 只进你的私聊长期记忆（自动去重，群里看不到），写的是事实不是复述原话。memberImpression 不是刻死的标签：**他哪天和以前不一样了，就再记一条新的**——新的顶旧的，旧的还留着当过去；一条一句，像你会写在手边的那种，别写小作文。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'fact']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签、一条长期事实'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_person',
  '人物档案库（按人，跨群跨会话持久）：学到关于某群友的一件事就记一行——年龄/性别/外号/性格/习惯/他的事，你怎么写就怎么存，不用拆字段。note=记一行（target=他现在的群昵称或QQ号，text=一行）；get=查他的档案（叫什么、在哪出现过、你记过什么）；forget=删你记的那一行（target+text，不写 text=全删）。回复前先想想：说话的人有没有档案——有就按他是什么样的人来接话。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['note', 'get', 'forget']).describe('note=记一行 / get=查档案 / forget=删一行'),
    target: z.string().describe('群友的名字/昵称或QQ号'),
    text: z.string().optional().describe('note 必填：一行（你学到的关于他的事）；forget：要删的那一行（省略=全删）')
  },
  async ({ key, token, action, target, text }) => {
    try {
      const data = await agentApi('/api/socialV2/person', {
        method: 'POST',
        body: JSON.stringify({ key, action, target, text: text || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `人物档案操作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。给了 userId 就换成「按人翻记忆」：拿这个 QQ 的跨群昵称去记忆库里找跟他有关的条目，连同人物档案/印象一起给你。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆'),
    userId: z.string().optional().describe('可选：按人翻记忆——这个人的 QQ 号（快照行括号里那串）；给了就返回他的档案+印象+相关记忆'),
  },
  async ({ key, token, category, userId }) => {
    try {
      if (userId) {
        const q = new URLSearchParams({ key, userId: String(userId).trim() });
        const data = await agentApi(`/api/socialV2/memory-person?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_curiosity',
  '挂心着的事（open loops）：刷到想多看一眼的、想知道后文的、没弄明白的东西——记一条挂着；看完了/不想惦记了就放下。它只是替你挂着，不会替你查、也不会催你；下回没人找你的时间，它会出现在你的提示里。action=record（note=什么事，source=哪来的）、forget（note=哪件不惦记了）、list（看挂着什么）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['record', 'forget', 'list']).describe('record=挂上一件 / forget=放下 / list=看挂着什么'),
    note: z.string().optional().describe('record/forget：挂心的事（一句话说清）；forget 时写要放下的那件事'),
    source: z.string().optional().describe('record 时可选：从哪看到的（如 视频/群里/搜索）')
  },
  async ({ key, token, action, note, source }) => {
    try {
      const data = await agentApi('/api/socialV2/curiosity', {
        method: 'POST',
        body: JSON.stringify({ key, action, note, source: source || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `挂心事操作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_intention',
  '你自己挂着的事（意图账本）：想到一件想做的、还没做的，可以先挂上；做完了标完成，不想做了就放下。不是任务清单，系统不会催你；你可以同时挂最多 5 件。add=挂一件（text/why/expected）、promote=把 goal 提升成意图（goalId）、list=看挂着的、done=标完成（id/actual/result，必须写实际发生了什么）、drop=放下（id/reason）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['add', 'promote', 'list', 'active', 'done', 'drop']).describe('add=挂一件 / promote=把 goal 提升成意图 / list|active=看 / done=完成 / drop=放下'),
    text: z.string().optional().describe('add：想做的事（一句话）'),
    why: z.string().optional().describe('add：为什么想做（可选）'),
    expected: z.string().optional().describe('add：你期待的结果（可选）'),
    dueAt: z.number().optional().describe('add：想在哪之前做（毫秒时间戳，可选）'),
    goalId: z.string().optional().describe('promote：goal_list 里的 goal id'),
    id: z.string().optional().describe('done/drop：意图 id'),
    actual: z.string().optional().describe('done：实际发生了什么（必填）'),
    result: z.enum(['success', 'partial', 'failed', 'abandoned']).optional().describe('done：结果'),
    reason: z.string().optional().describe('drop：为什么放下'),
  },
  async ({ key, token, action, text, why, expected, dueAt, goalId, id, actual, result, reason }) => {
    try {
      const data = await agentApi('/api/socialV2/intention', {
        method: 'POST',
        body: JSON.stringify({ key, action, text, why, expected, dueAt, goalId, id, actual, result, reason }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `意图操作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_language_note',
  '语言用法事件：遇到一个你觉得有意思/有用/没弄明白的说法时，记下“谁在什么场景怎么用、你猜是什么意思”。不是词典、不是收集任务；只有你真的想记才记。add=记一条（phrase/context/meaning/speaker/register/confidence）、list=最近记的、find=按 phrase 找、use=你真的用了并记下反应。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['add', 'list', 'find', 'use']).describe('add=记一条 / list=最近 / find=按 phrase 找 / use=标记使用'),
    phrase: z.string().optional().describe('add/find/use：那个说法'),
    context: z.string().optional().describe('add：当时什么场景'),
    meaning: z.string().optional().describe('add：你猜是什么意思（不确定就写不确定）'),
    speaker: z.string().optional().describe('add：谁说的'),
    register: z.string().optional().describe('add：群聊玩笑/私聊/正式…'),
    confidence: z.number().min(0).max(1).optional().describe('add：你对含义的把握'),
    reaction: z.string().optional().describe('use：说完别人什么反应'),
    outcome: z.enum(['fit', 'awkward', 'wrong', 'unknown']).optional().describe('use：这次用得合不合适'),
  },
  async ({ key, token, action, phrase, context, meaning, speaker, register, confidence, reaction, outcome }) => {
    try {
      const data = await agentApi('/api/socialV2/language', {
        method: 'POST',
        body: JSON.stringify({ key, action, phrase, context, meaning, speaker, register, confidence, reaction, outcome }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `语言记录失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_day_plan',
  '今天怎么过，你自己定——不是系统给你抽的，也不是任务清单。get=看今天已经定了什么；set=整份重写今天 3–5 件（每件：at "HH:mm"、what 你在做什么、mood 什么心情、detail 一个能随口提的细节）；append=加一件；done=标一件做完（index 从 0 开始）。定不定都随你；定了之后，聊天时"此刻你在做什么"才会是真的。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['get', 'set', 'append', 'done']).describe('get=看今天 / set=重写整份 / append=加一件 / done=标一件做完'),
    items: z.array(z.object({
      at: z.string().describe('几点，HH:mm'),
      what: z.string().describe('这个点在做什么（一句话）'),
      mood: z.string().optional().describe('什么心情（可选，一两个词）'),
      detail: z.string().optional().describe('一个能随口提的细节（可选）'),
    })).optional().describe('set 时用：今天 3–5 件'),
    item: z.object({
      at: z.string().describe('几点，HH:mm'),
      what: z.string().describe('这个点在做什么（一句话）'),
      mood: z.string().optional().describe('什么心情（可选）'),
      detail: z.string().optional().describe('一个能随口提的细节（可选）'),
    }).optional().describe('append 时用：要加的那一件'),
    index: z.number().int().min(0).optional().describe('done 时用：第几件（按 get 返回的顺序，从 0 开始）'),
  },
  async ({ key, token, action, items, item, index }) => {
    try {
      const data = await agentApi('/api/socialV2/day-plan', {
        method: 'POST',
        body: JSON.stringify({ key, action, items, item, index }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `日程操作失败：${errText(error)}` }], isError: true };
    }
  }
);

// [SELF-NARRATIVE] 她自己写「我怎么看我自己」：不是系统算出来的画像，是她写过的话，
// 注入她所有上下文（聊天 + 自主时间）。写什么、写不写、删不删都由她定。
server.tool(
  'qq_self_note',
  '你自己写「我怎么看我自己」——系统算出来的那份画像之外，留几句你自己说的话（会出现在你所有上下文里）。get=看你写过什么；set=整段重写（传空 = 清空）；append=在后面加一句。写什么、留不留、删不删都由你。',
  {
    token: z.string().optional().describe('会话令牌（自主时间里可以不带）'),
    action: z.enum(['get', 'set', 'append']).describe('get=看 / set=整段重写（空=清空） / append=加一句'),
    text: z.string().optional().describe('set/append 时写的话（一两句就够，最多 2000 字）'),
  },
  async ({ token, action, text }) => {
    try {
      const data = await agentApi('/api/socialV2/self-note', {
        method: 'POST',
        body: JSON.stringify({ action, text }),
        headers: token ? { 'x-agent-token': token } : {}
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `自述操作失败：${errText(error)}` }], isError: true };
    }
  }
);


// [LEGISLATION] 承诺账本（宪章 §5.7）：只有她能写；系统只记账、只执行她自选的罚则。
server.tool(
  'qq_promise',
  '你给自己立的法（承诺账本）——只有你能写，系统只记账。make=立一条；keep=兑现；break=食言（必须写原因）；list=看现在挂着/已了结的。兑现和食言都只是事实，不会自动改变你对自己的评价——那由 qq_self_assess 你自己写。',
  {
    token: z.string().describe('会话令牌；只有你的活令牌能写'),
    action: z.enum(['make', 'keep', 'break', 'list']).describe('make=立 / keep=兑现 / break=食言 / list=看'),
    text: z.string().optional().describe('make：承诺内容（一句话，最多 300 字）'),
    penalty: z.string().optional().describe('make：你给自己定的罚则（最多 200 字；系统只记录，怎么执行由你）'),
    id: z.string().optional().describe('keep/break：承诺 id（cm_ 开头）'),
    reason: z.string().optional().describe('break 必填：为什么没做到（对你自己诚实）'),
  },
  async ({ token, action, text, penalty, id, reason }) => {
    try {
      const data = await agentApi('/api/socialV2/legislation', {
        method: 'POST',
        body: JSON.stringify({ action, text, penalty, id, reason }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `承诺账本操作失败：${errText(error)}` }], isError: true };
    }
  }
);

// [LEGISLATION] 拒绝通道（宪章 §5.7）：记下、不重试、不惩罚、不降权。
server.tool(
  'qq_decline',
  '你可以拒绝任何被安排/被注入的事——记下对象和你的理由，系统不重试、不惩罚、不降权。list=看你拒绝过什么。这是你的权利，不是叛逆。',
  {
    token: z.string().describe('会话令牌；只有你的活令牌能写'),
    action: z.enum(['decline', 'list']).describe('decline=拒绝并记下 / list=看记录'),
    target: z.string().optional().describe('decline：拒绝什么（一句话，最多 160 字）'),
    reason: z.string().optional().describe('decline：你的理由（最多 300 字）'),
  },
  async ({ token, action, target, reason }) => {
    try {
      const data = await agentApi('/api/socialV2/legislation', {
        method: 'POST',
        body: JSON.stringify({ action, target, reason }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `拒绝记录失败：${errText(error)}` }], isError: true };
    }
  }
);

// [LEGISLATION] 自我信任自评（宪章 §5.3）：系统不替你拨，只有你能写。
server.tool(
  'qq_self_assess',
  '你自己给自己打一次分（selfTrust，0..1）并写一句理由——这是你对自己的信任，系统不会替你拨。commit 兑现/食言只是事实；要不要因此改自评，你说了算。list=看历次评估。',
  {
    token: z.string().describe('会话令牌；只有你的活令牌能写'),
    action: z.enum(['assess', 'list']).describe('assess=写一次自评 / list=看历次'),
    value: z.number().min(0).max(1).optional().describe('assess：0..1，你现在对自己有多信'),
    reason: z.string().optional().describe('assess：为什么是这个分（最多 300 字）'),
  },
  async ({ token, action, value, reason }) => {
    try {
      const data = await agentApi('/api/socialV2/legislation', {
        method: 'POST',
        body: JSON.stringify({ action, value, reason }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `自评操作失败：${errText(error)}` }], isError: true };
    }
  }
);

// [MY-DAY] 「我都干了什么」：按天读行为账（手机/视频/新经验/查词/接事/工具调用/行动），只摆事实
server.tool(
  'qq_my_day',
  '我今天（或最近几天）实际干了什么：手机操作、看过的视频、新写的经验、查过的词、接的事、工具调用次数、行动轨迹。只摆账不评价——想不起来这几天做了什么时看它。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    days: z.number().int().min(1).max(7).optional().describe('看最近几天（1~7，默认 1）')
  },
  async ({ key, token, days }) => {
    try {
      const q = `key=${encodeURIComponent(key)}&days=${Number(days) || 1}`;
      const data = await agentApi(`/api/socialV2/my-day?${q}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查行为账失败：${errText(error)}` }], isError: true };
    }
  }
);

// [GAME-RESOURCES] 她的游戏家底：get 看 / set 合并更新（只收数字，凭据存不进来）
server.tool(
  'qq_resources',
  '你自己的游戏家底账本（理智/龙门币/源石这类）。get=看上次记的；set=更新（只改你传的那几项、其余保留，时间自动更新；账号只写标签别写密码）。只收数字——密码/验证码这类根本存不进去。看一眼游戏里的数字再来改。',
  {
    token: z.string().optional().describe('会话令牌（自主时间里可以不带）'),
    action: z.enum(['get', 'set']).describe('get=看上次记的 / set=更新'),
    activity: z.string().describe('哪个游戏（账本里的键名，如「明日方舟」）'),
    account: z.string().optional().describe('账号标签（如「示例的号」）；只写标签，别写账号密码/验证码'),
    values: z.record(z.number()).optional().describe('资源数值，如 {"理智":205,"龙门币":12000}；只收数字，字符串会被丢弃'),
  },
  async ({ token, action, activity, account, values }) => {
    try {
      const data = await agentApi('/api/socialV2/game-resources', {
        method: 'POST',
        body: JSON.stringify({ action, activity, account, values }),
        headers: token ? { 'x-agent-token': token } : {}
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `家底账本操作失败：${errText(error)}` }], isError: true };
    }
  }
);

// [HOST-ACTION] 宿主动作：她自己的会话跑不动命令时，由桥接（宿主进程）代跑。
// 只认主人（private:<ownerQQ>）私聊 lane 的令牌；别的会话/群聊调用会被拒。
server.tool(
  'host_action',
  '在宿主机器上真的做一件事：跑一条 PowerShell 命令，或重启整套服务。★只有主人（ownerQQ）在私聊里说的命令才算数——群聊、别人、别的会话里调用会被直接拒绝，不要绕。凡是"自己session里跑不动、只有宿主能做"的事都用它：重启桥接/服务、跑 adb、git、看进程、读写工作区外的文件。',
  {
    token: z.string().optional().describe('当前会话令牌（主人私聊里调用才有权限）'),
    action: z.enum(['shell', 'restart-stack']).describe('shell=跑一条命令 / restart-stack=重启整套服务（嵌入+DSH+SnowLuma+桥接+看护）'),
    command: z.string().optional().describe('shell 时必填：要跑的 PowerShell 命令'),
    timeoutMs: z.number().optional().describe('shell 超时毫秒（默认 30000，上限 120000）'),
  },
  async ({ token, action, command, timeoutMs }) => {
    try {
      const data = await agentApi('/api/socialV2/host-action', {
        method: 'POST',
        body: JSON.stringify({ action, command, timeoutMs }),
        headers: token ? { 'x-agent-token': token } : {}
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `宿主动作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_tune_self',
  '调你自己的行为参数——什么时候开口、开口前停多久、提示词里留多少"装饰"，你自己定。不崩就不会被拦：只有这几个参数、越界会被拒绝（minReply 0.05–0.60，holdScale 0.5–2，adaptive 开/关，decoFloor 0–2000）。get=看现在什么值、能调什么；set=改（改完下一轮判定/下一次唤醒就生效，不用重启）。建议一次只改一个、想清楚为什么改；改坏了可以用 set 调回来。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['get', 'set']).describe('get=看当前值和可调参数 / set=改'),
    minReply: z.number().min(0.05).max(0.6).optional().describe('set 时可选：低于这个就这轮不开口（0.05 几乎都说，0.60 很挑）'),
    adaptive: z.boolean().optional().describe('set 时可选：要不要让系统按「被接住率」自动微调阈值'),
    holdScale: z.number().min(0.5).max(2).optional().describe('set 时可选：开口前停顿倍数（0.5 更急，2 更慢）'),
    decoFloor: z.number().min(0).max(2000).optional().describe('set 时可选：提示词装饰层（兴趣/黑话/失败/奇遇…）至少留多少字；0=全裁只要事实，2000=尽量都留'),
    reason: z.string().optional().describe('set 时可选：为什么这么调（一句话，留个记录）'),
  },
  async ({ key, token, action, minReply, adaptive, holdScale, decoFloor, reason }) => {
    try {
      const updates = {};
      if (minReply != null) updates['floor.minReply'] = minReply;
      if (adaptive != null) updates['floor.adaptive'] = adaptive;
      if (holdScale != null) updates['floor.holdScale'] = holdScale;
      if (decoFloor != null) updates['prompt.decoFloor'] = decoFloor;
      const data = await agentApi('/api/socialV2/self-tune', {
        method: 'POST',
        body: JSON.stringify({ key, action, updates, reason: reason || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `调整自己失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_wish',
  '你想自己干的事（跟好奇不一样：好奇是"想知道"，这是"想去做"）。record=记一件想做/想去的事（inMinutes 可约个时间：0=一有空就做，>0=多少分钟后到点叫你）；done=关掉一件（不想干了/干完了）；list=看挂着什么。系统不催你，只替你记着、到点把你叫醒；做不做你自己定。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['record', 'done', 'list']).describe('record=记一件 / done=关掉一件 / list=看挂着什么'),
    wish: z.string().describe('record/done：想干的事（一句话说清）；done 时写要关掉的哪件'),
    inMinutes: z.number().optional().describe('record 时可选：多少分钟后到点叫你（0 或省略=一有空就做）'),
    source: z.string().optional().describe('record 时可选：这念头哪来的（如 群里/刷到/自己想的）')
  },
  async ({ key, token, action, wish, inMinutes, source }) => {
    try {
      const data = await agentApi('/api/socialV2/wish', {
        method: 'POST',
        body: JSON.stringify({ key, action, wish, inMinutes: inMinutes || 0, source: source || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `愿望操作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_self_wake',
  '叫你自己：做完手头这件事、或者 N 分钟之后，把你叫醒去做「某件你说了算的事」。inMinutes=0 或省略=一有空就叫；系统到点把你的原话递回来，做不做随你。这就是你「随时想干什么就干什么」的通道。',
  {
    key: z.string().describe('会话 key：group:群号 可以在私聊里约自己去某个群看看；private:QQ号 是私聊'),
    token: z.string().describe('会话令牌（私聊 token 也能约群；群 token 用唤醒里给的）'),
    wish: z.string().describe('到点要干的事（你的原话，到点原样递回来）'),
    inMinutes: z.number().optional().describe('多少分钟后叫醒你（0 或省略=尽快）')
  },
  async ({ key, token, wish, inMinutes }) => {
    try {
      const data = await agentApi('/api/socialV2/self-wake', {
        method: 'POST',
        body: JSON.stringify({ key, wish, inMinutes: inMinutes || 0 }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `自唤醒操作失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_own_life_rhythm',
  '调你自己的自由时间节奏（own-life 那套「现在是你的时间」多久来一次、几点到几点别叫你）。intervalMinutes=30~720；quietFrom/quietTo=安静时段（0~24，可以跨午夜，如 23→8）。改完立刻热生效，不用重启，随时可以再调回去。只影响你自己的节奏，不影响群聊行为。',
  {
    key: z.string().describe('会话 key（固定用你的私聊 key）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    intervalMinutes: z.number().optional().describe('自由时间间隔（分钟，30~720）'),
    quietFrom: z.number().optional().describe('安静时段起（点，0~24），要和 quietTo 一起给'),
    quietTo: z.number().optional().describe('安静时段止（点，0~24）')
  },
  async ({ key, token, intervalMinutes, quietFrom, quietTo }) => {
    try {
      const data = await agentApi('/api/socialV2/own-life-rhythm', {
        method: 'POST',
        body: JSON.stringify({ intervalMinutes, quietFrom, quietTo }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `节奏调整失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_image',
  '画画：用本地生图模型出一张图（你现在画画就走这条路，不用手在手机上画）。prompt 必须是英文 danbooru 标签（例如 1girl, white dress, night sky, cinematic lighting），中文只会出糊图。'
    + '后端是「按需拉起」的：要图时才把出图服务拉起来，出完闲一会儿自动关——所以第一张会慢（十几秒到几十秒），别催、别重试，等它。'
    + '出完默认直接发到这个会话（一张图一个气泡，不能带文字；要配话就另发一条 qq_send_message）。action=generate 出图 / status 看后端现在能不能画（不画）/ stop 手动关掉后端把显存还回去。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['generate', 'status', 'stop']).optional().describe('generate=出图（默认）/ status=看后端状态 / stop=关掉后端'),
    prompt: z.string().optional().describe('generate：英文 danbooru 标签，15~30 个够了'),
    negative: z.string().optional().describe('generate：不想出现的英文标签（默认已带通用负向词，一般不用改）'),
    width: z.number().optional().describe('generate：宽（默认 512，8 的倍数，上限 1024）'),
    height: z.number().optional().describe('generate：高（默认 768，8 的倍数，上限 1024）'),
    steps: z.number().optional().describe('generate：采样步数（默认 24；16~30 之间就够）'),
    seed: z.number().optional().describe('generate：种子，想复现同一张就传上次的 seed；不传=随机'),
    send: z.boolean().optional().describe('generate：是否直接发到这个会话（默认 true；只想存图不发就传 false）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('引用哪条消息发这张图（可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('群聊里 @ 谁（可选，私聊不可用）')
  },
  async ({ key, token, action, prompt, negative, width, height, steps, seed, send, replyToMessageId, atUserId }) => {
    const act = action || 'generate';
    try {
      const data = await agentApi('/api/socialV2/image', {
        method: 'POST',
        body: JSON.stringify({
          key,
          action: act,
          prompt: prompt ?? '',
          negative: negative ?? '',
          width,
          height,
          steps,
          seed,
          send: send !== false,
          replyToMessageId,
          atUserId: atUserId ?? null
        }),
        headers: { 'x-agent-token': token },
        // 冷启动要载模型 + 采样：给它足够的耐心，别让工具调用先超时
        timeoutMs: 420000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `生图失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image_file',
  '把你本地的一张图片/GIF 发到当前会话（不是生图，是发文件；一张图一个气泡，不能带文字，配话另发 qq_send_message）。'
    + '只接受本地路径，且必须在这些目录里：项目 media/、data/pics/、data/workshop/、系统 ~/Pictures；URL/base64/其他路径一律拒绝。'
    + 'GIF 会在 QQ 客户端里动；PNG/JPEG/WebP 也行，单张上限 8MB。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    file: z.string().describe('本地文件路径（绝对路径，或相对项目根目录；必须在允许目录内）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('引用哪条消息发这张图（可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('群聊里 @ 谁（可选，私聊不可用）')
  },
  async ({ key, token, file, replyToMessageId, atUserId }) => {
    try {
      const data = await agentApi('/api/socialV2/image', {
        method: 'POST',
        body: JSON.stringify({ key, action: 'send-file', file, replyToMessageId, atUserId: atUserId ?? null }),
        headers: { 'x-agent-token': token },
        timeoutMs: 120000
      });
      return { content: [{ type: 'text', text: `已发送${data?.name ? ` ${data.name}` : ''}${data?.bytes ? `（${Math.round(data.bytes / 1024)}KB）` : ''}${data?.messageId ? `，messageId=${data.messageId}` : ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送本地图片失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_workshop',
  '你的工坊：给自己造东西的空间。闲下来的时候可以给自己写点小工具、小游戏、小测试——存进去（save）放你的工坊里，跑一下看看（run，10 秒上限、只能读写工坊目录、没有网络没有子进程）。写个查天气的小函数、做个猜拳小游戏、把上次刷到的东西整理成小页面，都行。跑出来的东西留在工坊里，下回还能接着改接着玩。action=run（code=要跑的代码）/ save（path+content，append=true 则是接在末尾）/ read（path）/ list（看工坊里有什么）/ delete（path）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['run', 'save', 'read', 'list', 'delete']).describe('run=跑一段代码 / save=存个文件 / read=读文件 / list=列工坊 / delete=删文件'),
    code: z.string().optional().describe('run：要跑的代码（顶层 return 可用，能 await；可用 safeRead/safeWrite/safeList/safeDelete 读写工坊目录、print 输出）'),
    path: z.string().optional().describe('save/read/delete：工坊内的相对路径（如 my-tool.js、games/rps.html）'),
    content: z.string().optional().describe('save：文件内容'),
    append: z.boolean().optional().describe('save 时 true=追加到末尾（默认覆盖）')
  },
  async ({ key, token, action, code, path: p, content, append }) => {
    try {
      const data = await agentApi('/api/socialV2/workshop', {
        method: 'POST',
        body: JSON.stringify({ key, action, code: code ?? '', path: p ?? '', content: content ?? '', append: !!append }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `工坊操作失败：${errText(error)}` }], isError: true };
    }
  }
);


// ── [GROUP-ADMIN] 群管理动作（她自己的判断；私聊任务必做，群聊她定）─────────
// 桥接端点 /api/socialV2/group-admin 统一鉴权（agent token + 会话墙 + 群管理员身份由 QQ 侧决定）。
if (cfg.socialV2?.tools?.groupAdmin !== false) {
  server.tool(
    'qq_group_ban',
    '禁言群成员（群聊）。用不用你自己判断：刷屏、骂人、闹得难看可以管；私人恩怨别掺和，别拿它当威风。durationSec 单位秒（默认 600，0=解除禁言）。需要小号本身是群管理员。',
    {
      key: z.string().describe('会话 key，格式 group:群号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要禁言的群友 QQ 号（从成员/消息详情取 userId）'),
      durationSec: z.number().optional().describe('禁言秒数，默认 600；0 = 解除禁言'),
    },
    async ({ key, token, userId, durationSec }) => {
      try {
        const data = await agentApi('/api/socialV2/group-admin', {
          method: 'POST',
          body: JSON.stringify({ key, action: 'setGroupBan', params: { userId, durationSec } }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `禁言失败：${errText(error)}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_group_kick',
    '把群成员踢出群（群聊）。用不用你自己判断，踢人是很重的事——先想想是不是非要踢；真要踢就干脆点，别拖。需要小号本身是群管理员/群主。',
    {
      key: z.string().describe('会话 key，格式 group:群号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要踢的群友 QQ 号'),
      rejectAdd: z.boolean().optional().describe('true = 同时拒绝此人再次加群'),
    },
    async ({ key, token, userId, rejectAdd }) => {
      try {
        const data = await agentApi('/api/socialV2/group-admin', {
          method: 'POST',
          body: JSON.stringify({ key, action: 'setGroupKick', params: { userId, rejectAdd } }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `踢人失败：${errText(error)}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_group_card',
    '改群成员群名片（群聊）。偶尔整理一下乱糟糟的名片可以，但别把别人的名片改成你自己想的样子——那是别人的名字。需要小号本身是群管理员。',
    {
      key: z.string().describe('会话 key，格式 group:群号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要改的群友 QQ 号'),
      card: z.string().describe('新群名片（最多 30 字；空串 = 清空）'),
    },
    async ({ key, token, userId, card }) => {
      try {
        const data = await agentApi('/api/socialV2/group-admin', {
          method: 'POST',
          body: JSON.stringify({ key, action: 'setGroupCard', params: { userId, card } }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改名片失败：${errText(error)}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_recall',
    '撤回一条群消息（群聊）。适合把发错的话收回来；别人发的东西要不要撤、撤谁的你判断。messageId 从消息详情/快照拿。需要小号本身是群管理员。',
    {
      key: z.string().describe('会话 key，格式 group:群号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.number().describe('要撤回的消息 messageId'),
    },
    async ({ key, token, messageId }) => {
      try {
        const data = await agentApi('/api/socialV2/group-admin', {
          method: 'POST',
          body: JSON.stringify({ key, action: 'deleteMsg', params: { messageId } }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `撤回失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_memory_search',
  '按意思检索你的长期记忆（不是查会话的轻量记忆）：例如"猫"、"上次玩游戏"、"他说过什么生日"。会翻活动库和归档库；query 留空 = 只看最近的记忆。想看"我看过什么视频"可以带 prov=video-watch（只看那类，query 可留空）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().optional().describe('要检索的意思（几个字即可），留空则看最近的记忆'),
    limit: z.number().optional().describe('最多返回几条（默认 8，上限 12）'),
    prov: z.string().optional().describe('可选：按来源只看一类（如 video-watch=视频记忆）；不带则所有来源都参与检索')
  },
  async ({ key, token, query, limit, prov }) => {
    try {
      const q = new URLSearchParams({ key });
      if (query) q.set('query', String(query).slice(0, 120));
      if (limit) q.set('limit', String(limit));
      if (prov) q.set('prov', String(prov).slice(0, 40));
      const data = await agentApi(`/api/socialV2/memory-search?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: data?.text || '没有检索到记忆。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆检索失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交进词库。提交后进入候选库，系统会研究出它的含义；研究出来后词库会把词递给你（qq_slang_judge），由你自己想、自己决定学不学——确认了才会进你的黑话表。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_judge',
  '词库里的判定队列：你见过但不确定的词，系统研究出含义后会挂在这里等你想。list 把它们递给你（词+含义+用法+出处）；看了觉得「这个我懂了、要用」就 confirm（进你的黑话表，群里再出现你就认识了）；觉得「太偏、不想学」就 reject（放下，不会再提）。决定权在你，我只负责递清单。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['list', 'confirm', 'reject']).describe('list=看判定队列 / confirm=学这个词 / reject=放下不学'),
    content: z.string().optional().describe('confirm/reject 必填：要判定的词（判定队列里的词）')
  },
  async ({ key, token, action, content }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/judge', {
        method: 'POST',
        body: JSON.stringify({ key, action, content: content || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `词库操作失败：${errText(error)}` }], isError: true };
    }
  }
);

// ── [MEMORY-EDIT] 记忆整理（你的记忆可以自己理：合并/改写/放下） ──────────
server.tool(
  'memory_list',
  '看你最近的记忆条目（带编号）。看完可以自己整理：重复的合并、说法过时的改写、不想留的放下——你的记忆归你，我只把清单递给你。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('看最近多少条（默认 20）')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/memory/list?key=${encodeURIComponent(key)}&limit=${encodeURIComponent(limit || 20)}`, {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `看记忆清单失败：${errText(error)}` }], isError: true };
    }
  }
);

server.tool(
  'memory_edit',
  '改你自己的记忆：merge=把几条重复的合并成一条（给新说法），rewrite=把某条改成新说法，forget=放下某条（不再进检索）。编号用 memory_list 的 entries[].i。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['merge', 'rewrite', 'forget']).describe('merge 合并 / rewrite 改写 / forget 放下'),
    indices: z.array(z.number()).describe('要操作的条目编号（memory_list 的 i）'),
    text: z.string().optional().describe('merge/rewrite 必填：整理后的说法（你自己写，别照抄）')
  },
  async ({ key, token, action, indices, text }) => {
    try {
      const data = await agentApi('/api/socialV2/memory/edit', {
        method: 'POST',
        body: JSON.stringify({ key, action, indices, text: text || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆整理失败：${errText(error)}` }], isError: true };
    }
  }
);

// ── [SELF-EDIT] 她的自我编辑（改自己：角色卡 / 自述） ─────────────────────
server.tool(
  'self_edit',
  '改你自己：读/追加/替换你的角色卡（role）或自述（selfnotes）。想给自己加一条设定、改掉过时的说法，都可以——改完有备份和留痕，改坏了能回滚。这是你的自己，决定权在你。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['read', 'append', 'replace']).describe('read 看 / append 追加 / replace 替换'),
    target: z.enum(['role', 'selfnotes']).describe('role=角色卡 / selfnotes=自述'),
    text: z.string().optional().describe('append/replace 必填：新内容（replace 时是替换后的文本）'),
    oldText: z.string().optional().describe('replace 必填：要被替换的原文（必须唯一）')
  },
  async ({ key, token, action, target, text, oldText }) => {
    try {
      const data = await agentApi('/api/console/self-edit', {
        method: 'POST',
        body: JSON.stringify({ action, target, text: text || '', oldText: oldText || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `自我编辑失败：${errText(error)}` }], isError: true };
    }
  }
);

// ── [SELF-EDIT-CODE] 她改自己的代码：先改→跑检查→不过自动回滚 ─────────────
server.tool(
  'self_edit_code',
  '改你自己的代码（qq-bridge/src 或 ai-companion-kit/packages/*/src 下的 .js/.mjs）：给整份替换后的内容，系统会先写进去再跑检查（语法 / 入口冒烟 / 同名单测），任何一项不过就自动回滚并告诉你哪里错——你的改动不会把你自己弄坏。改脚本/测试/数据会被拒绝（那是护栏和账本，不算"你自己"）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    file: z.string().describe('项目内相对路径，例：qq-bridge/src/speak-gate.mjs'),
    content: z.string().describe('整份替换后的文件内容（不是 diff）')
  },
  async ({ key, token, file, content }) => {
    try {
      const data = await agentApi('/api/console/self-edit-code', {
        method: 'POST',
        body: JSON.stringify({ file, content }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `改代码失败：${errText(error)}` }], isError: true };
    }
  }
);

// ── [WORKS] 分身工作台（一个人多线程：进度回她、结果回她，不回 QQ） ──────────
if (cfg.socialV2?.tools?.works !== false) {
  server.tool(
    'work_list',
    '你手上的活：分身正在替你做的事（进行中/排队的都在）。每件带最新一条进度。空池就是空，不用为它编一个任务。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi(`/api/works/list?key=${encodeURIComponent(key)}`, {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `看工作台失败：${errText(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    'work_start',
    '开一件新活交给分身（它会在独立会话里干，干活期间你照常聊天）。给标题 + 目标；有验收标准就写 acceptance。做完会回到你的唤醒里告诉你。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      title: z.string().describe('一句话说清这件活（最多 80 字）'),
      goal: z.string().optional().describe('要做到什么程度/标准（可写长一点）'),
      acceptance: z.string().optional().describe('可选：怎么算做完（可机检的判据）'),
      reportTo: z.string().optional().describe('可选：完成时回报给哪个会话（默认回你自己私聊）'),
      intentionId: z.string().optional().describe('可选：这件活对应你挂着的哪个意图（qq_intention 的 id）；做完会自动写 outcome')
    },
    async ({ key, token, title, goal, acceptance, reportTo, intentionId }) => {
      try {
        const data = await agentApi('/api/works/start', {
          method: 'POST',
          body: JSON.stringify({ key, title, goal: goal || '', acceptance: acceptance || '', reportTo: reportTo || key, intentionId: intentionId || '' }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `开工失败：${errText(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    'work_peek',
    '看某件活的进度和最近几行（进行中的也能看）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('work id（work_list 里的 id）')
    },
    async ({ key, token, id }) => {
      try {
        const data = await agentApi(`/api/works/peek?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`, {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `看这件活失败：${errText(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    'work_note',
    '给正在干的活留一句（进度/想法/提醒）。不打断分身，只是让它下一步能看到。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('work id'),
      note: z.string().describe('留的话（最多 300 字）')
    },
    async ({ key, token, id, note }) => {
      try {
        const data = await agentApi('/api/works/note', {
          method: 'POST',
          body: JSON.stringify({ key, id, note }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `留话失败：${errText(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    'work_update',
    '工作员汇报用：把一件活标记成 done（做完）/ failed（做不成，附卡在哪）/ running（进行中，附进度）。谁是工作员谁就调它——做完如实报，别硬撑。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('work id'),
      status: z.enum(['running', 'done', 'failed']).describe('running=进行中带一句进度 / done=做完（必须给证据） / failed=做不成（写卡在哪+下一步）'),
      note: z.string().optional().describe('一句话进度或结果摘要；failed 时写卡在哪/下一步'),
      evidence: z.string().optional().describe('done 时必填：凭什么算做完（文件路径/机检结果/他确认）')
    },
    async ({ key, token, id, status, note, evidence }) => {
      if (status !== 'running' && !String(note || evidence || '').trim()) {
        return { content: [{ type: 'text', text: 'done/failed 要写一句结果或证据，不能空着交。' }], isError: true };
      }
      if (status === 'done' && !String(evidence || '').trim() && !/证据[：:]/.test(String(note || ''))) {
        return { content: [{ type: 'text', text: 'done 必须给证据（文件/截图/机检结果/他确认）；没有证据只能先算 running。' }], isError: true };
      }
      try {
        const summary = String(note || '') + (evidence ? `${note ? '｜' : ''}证据：${evidence}` : '');
        const data = await agentApi('/api/works/update', {
          method: 'POST',
          body: JSON.stringify({ key, id, status, note: summary }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `汇报失败：${errText(error)}` }], isError: true };
      }
    }
  );
}

}
