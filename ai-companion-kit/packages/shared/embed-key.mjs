// embed-key.mjs · 嵌入缓存键（G3 硬验收：带模型+维度，换模型不再静默污染）
//
// memory-mcp（MCP 服务）与 qq-bridge 的 memory-retrieve（桥接召回）共享同一把钥匙：
// 两边若各算各的 sha(text)，一旦嵌入模型/维度变化，旧 key 永不失效、新向量永远重算，
// 更糟的是换模型后旧向量会被误当成新模型向量 → 相似度 silently 错乱。
// 把公式收口到这唯一模块，谁都不能自己造一个。
import crypto from 'node:crypto';

export const EMBED_MODEL = 'bge-m3';
export const EMBED_DIM = 1024;

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** 缓存 key：模型@维度|<正文>。同一正文换模型 → key 变 → 旧缓存自动失效、互不污染。 */
export const embedKey = (text) => sha(`${EMBED_MODEL}@${EMBED_DIM}|${text}`);
