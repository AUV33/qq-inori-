// vision-service.js · 看图会话的生命周期（申请槽位 → 提交图片 → 收 turn → 超时/失败清理）
//
// 从 bridge.js 抽出来的独立状态机：bridge 只负责接线（ensureIsolatedSession / 槽位 / 投递），
// 这里负责「一次看图请求」的完整生命周期和并发等待者。抽出来的理由：控制台视觉、表情包打标、
// 手机视觉共用同一条链路，原来在 bridge 里复制了两份，容易一边修了另一边漏。
//
// 依赖全部由调用方注入（不读全局、不读文件），因此可以单测。

/**
 * @param {object} deps
 * @param {() => boolean} deps.isReady  DSH 是否可用
 * @param {(kind: string) => Promise<string>} deps.ensureSession 取（或建）隔离会话
 * @param {(sessionId: string) => void} deps.follow 订阅会话事件（漏订阅会等到超时）
 * @param {(label: string, opts: object) => Promise<any>} deps.acquireSlot
 * @param {(grant: any, sessionId: string) => any} deps.bindGrant
 * @param {(grant: any) => void} deps.releaseGrant
 * @param {(req: object) => Promise<any>} deps.submit 投递 prompt（统一包装器）
 * @param {() => any} deps.createCollector 每会话一个 turn 收集器
 * @param {(line: string) => void} [deps.log]
 */
export function createVisionService(deps) {
  const {
    isReady = () => false,
    ensureSession,
    follow = () => {},
    acquireSlot,
    bindGrant = () => {},
    releaseGrant = () => {},
    submit,
    createCollector,
    log = () => {},
  } = deps ?? {};

  const sessions = new Set();
  const collectors = new Map();
  const waiters = new Map();

  function dropWaiter(waiter) {
    for (const [sessionId, arr] of waiters) {
      const index = arr.indexOf(waiter);
      if (index >= 0) arr.splice(index, 1);
      if (!arr.length) waiters.delete(sessionId);
    }
  }

  /**
   * 看一次图。返回模型给的字；超时/被拒/异常都会清掉 grant 与等待者。
   * @param {string[]} images base64（不含 data: 前缀）
   */
  async function ask(images, question, { mimeType = 'image/png', timeoutMs = 90000 } = {}) {
    if (!isReady()) throw new Error('DSH 当前不可用');
    if (!Array.isArray(images) || !images.length) throw new Error('images 不能为空');
    const sessionId = await ensureSession('vision');
    sessions.add(sessionId);
    try { follow(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'vision-service.js:55'); }
    const grant = await acquireSlot('isolated:vision', { kind: 'background' });
    bindGrant(grant, sessionId);

    let waiter = null;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dropWaiter(waiter);
        reject(new Error(`看图超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      waiter = { resolve, reject, timer };
      const arr = waiters.get(sessionId) ?? [];
      arr.push(waiter);
      waiters.set(sessionId, arr);
    });

    const text = images.length > 1
      ? `${question}（这是连续 ${images.length} 帧，按顺序看变化）`
      : question;
    const content = [{ type: 'text', text }];
    for (const b64 of images.slice(0, 5)) content.push({ type: 'image', mediaType: mimeType, data: b64 });

    try {
      const accepted = await submit({ sessionId, label: 'isolated:vision', kind: 'background', content, turnGrant: grant });
      if (!accepted?.result?.ok) {
        throw new Error(`投递被拒: ${accepted?.result?.error?.code}: ${accepted?.result?.error?.message}`);
      }
      return await answer;
    } catch (error) {
      releaseGrant(grant);
      if (waiter) {
        clearTimeout(waiter.timer);
        dropWaiter(waiter);
      }
      throw error;
    }
  }

  /**
   * 会话事件入口：是看图会话就吃下这条事件，返回 true（bridge 不再当群事实等处理）。
   */
  function handleEvent(frame) {
    const sessionId = frame?.sessionId;
    if (!sessionId || !sessions.has(sessionId)) return false;
    const type = frame?.event?.type;
    if (type === 'turn/start' || type === 'turn/end') {
      log(`[vision-debug] ${type} ${String(sessionId).slice(0, 14)}`);
    }
    const collector = collectors.get(sessionId) ?? createCollector();
    collectors.set(sessionId, collector);
    const ended = collector.push(frame.event);
    if (!ended) return true;
    collectors.delete(sessionId);
    const arr = waiters.get(sessionId) ?? [];
    const waiter = arr.shift();
    if (!arr.length) waiters.delete(sessionId);
    if (!waiter) return true;
    clearTimeout(waiter.timer);
    if (ended.reason?.kind === 'completed' && String(ended.text ?? '').trim()) {
      waiter.resolve(ended.text);
    } else {
      waiter.reject(new Error(`看图 turn 未完成：${ended.reason?.kind}；${JSON.stringify(ended.reason ?? {}).slice(0, 200)}`));
    }
    return true;
  }

  /** 只读：当前登记在案的看图会话（测试与排查用） */
  function activeSessions() {
    return [...sessions];
  }

  return { ask, handleEvent, activeSessions, sessions };
}
