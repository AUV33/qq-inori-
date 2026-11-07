// life-log.mjs · 生命线：只追加的事件流（她经历过什么）
//
// 干什么：把消息、情绪、信念、记忆、意图、动作、结果、睡眠、进程起停写成按天分段的事件流；
//         支持按时间读、取最近 N 条、重放。
// 为什么：现状状态散落且无事件史（蓝图 G2/G5）；没有它就无法回答“我不在时发生了什么”，也无法回放决策。
// 输入输出：工厂返回 log；append 事件，read/tail 事件；JSONL，一行一条。
// 失败模式：单行损坏跳过；写入失败向上抛（由调用方决定是否降级）。
// 不做什么：不做投影（SelfState/Belief 由消费方重放得到）、不做全文索引、不决定业务事件类型。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.1（主观时间与生命线）

import nodeFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LIFE_LOG_VERSION = 1;

function dayOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function parseLines(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* 容错：坏行跳过 */ }
  }
  return rows;
}

/**
 * @param {{root:string, fsImpl?:object, clock?:()=>number, idFactory?:()=>string}} opts
 */
export function createLifeLog(opts = {}) {
  if (!opts.root || typeof opts.root !== 'string') throw new Error('life-log: root required');
  const root = path.resolve(opts.root);
  const io = opts.fsImpl || nodeFs;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => 'evt_' + crypto.randomUUID();

  function fileOf(at) {
    return path.join(root, dayOf(at) + '.jsonl');
  }

  function normalize(event, at) {
    if (!event || typeof event !== 'object') throw new Error('life-log: event object required');
    const type = typeof event.type === 'string' ? event.type.trim() : '';
    if (!type) throw new Error('life-log: event.type required');
    return {
      v: LIFE_LOG_VERSION,
      id: typeof event.id === 'string' && event.id ? event.id : idFactory(),
      at: Number.isFinite(event.at) ? event.at : at,
      type,
      key: typeof event.key === 'string' ? event.key : '',
      actor: typeof event.actor === 'string' ? event.actor : '',
      payload: event.payload && typeof event.payload === 'object' ? event.payload : (event.payload === undefined ? {} : event.payload),
      trace: event.trace && typeof event.trace === 'object' ? event.trace : {},
    };
  }

  function append(event, options = {}) {
    const at = Number.isFinite(options.at) ? options.at : clock();
    const row = normalize(event, at);
    io.mkdirSync(root, { recursive: true });
    io.appendFileSync(fileOf(row.at), JSON.stringify(row) + '\n', 'utf8');
    return row;
  }

  function files() {
    try {
      return io.readdirSync(root)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function read(options = {}) {
    const from = Number.isFinite(options.from) ? options.from : -Infinity;
    const to = Number.isFinite(options.to) ? options.to : Infinity;
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : Infinity;
    const typeFilter = typeof options.type === 'string' ? options.type : '';
    const keyFilter = typeof options.key === 'string' ? options.key : '';
    const fromDay = from === -Infinity ? '' : dayOf(from);
    const toDay = to === Infinity ? '' : dayOf(to);
    const rows = [];
    for (const name of files()) {
      const day = name.slice(0, 10);
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      let text;
      try { text = io.readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
      for (const row of parseLines(text)) {
        if (!Number.isFinite(row.at) || row.at < from || row.at > to) continue;
        if (typeFilter && row.type !== typeFilter) continue;
        if (keyFilter && row.key !== keyFilter) continue;
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.at - b.at);
    return limit === Infinity ? rows : rows.slice(-limit);
  }

  function tail(limit = 50, options = {}) {
    return read({ ...options, limit });
  }

  function replay(options, visitor) {
    if (typeof visitor !== 'function') throw new Error('life-log: visitor required');
    const rows = read(options);
    for (const row of rows) visitor(row);
    return rows.length;
  }

  function stats() {
    const list = files();
    let bytes = 0;
    let events = 0;
    for (const name of list) {
      try {
        const st = io.statSync(path.join(root, name));
        bytes += st.size;
        events += parseLines(io.readFileSync(path.join(root, name), 'utf8')).length;
      } catch { /* skip */ }
    }
    return { days: list.length, bytes, events, firstDay: list[0] || '', lastDay: list.at(-1) || '' };
  }

  return { v: LIFE_LOG_VERSION, root, append, read, tail, replay, stats, files, fileOf };
}

export { dayOf };
