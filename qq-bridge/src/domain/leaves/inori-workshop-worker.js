// inori-workshop-worker.js · 工坊沙箱执行（独立线程）
// 主线程通过 inori-workshop.js 的 runScript 启动；这里把她的代码包成 async IIFE 在 vm 上下文里跑，
// 超时可被 worker.terminate() 真打断（主线程看门狗）。API 注入与主模块一致。
import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';
import { readWorkshop, writeWorkshop, listWorkshop, deleteWorkshop } from './inori-workshop.js';

const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  if (v === null) return 'null';
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
};

parentPort.on('message', (msg) => {
  const { code, timeoutMs = 10000, outputCap = 4096 } = msg;
  const out = { lines: [], trunc: false };
  const emit = (s) => {
    if (out.lines.length > 4000) return;
    out.lines.push(s);
    if (out.lines.join('\n').length > outputCap) out.trunc = true;
  };
  const sandbox = {
    console: { log: (...a) => emit(a.map(fmt).join(' ')), error: (...a) => emit('⚠ ' + a.map(fmt).join(' ')), warn: (...a) => emit('⚠ ' + a.map(fmt).join(' ')) },
    print: (...a) => emit(a.map(fmt).join(' ')),
    safeRead: (p) => readWorkshop(String(p)),
    safeWrite: (p, text, append) => writeWorkshop(String(p), String(text), !!append),
    safeList: () => listWorkshop(),
    safeDelete: (p) => deleteWorkshop(String(p)),
    Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set,
    // 短延时（沙箱脚本里的 await 用）；worker 有 vm timeout + 主看门狗双兜底，不会挂死
    setTimeout: (fn, ms, ...args) => setTimeout(() => { try { fn(...args); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-workshop-worker.js:32'); } }, Number(ms) || 0),
    clearTimeout: (h) => clearTimeout(h),
  };
  // 包成 async IIFE：顶层 return 合法；async 脚本也能 await
  const wrapped = `(async () => {\n${String(code ?? '')}\n})()`;
  (async () => {
    try {
      const ctx = vm.createContext(sandbox);
      const script = new vm.Script(wrapped, { filename: 'workshop-script.js' });
      const result = await script.runInContext(ctx, { timeout: timeoutMs });
      const text = out.lines.join('\n').slice(0, outputCap);
      parentPort.postMessage({ ok: true, output: text, result: result !== undefined ? fmt(result) : '', trunc: out.trunc });
    } catch (e) {
      const text = out.lines.join('\n').slice(0, outputCap);
      const msg = e?.message ?? String(e);
      parentPort.postMessage({ ok: false, output: text, error: /timed out|Timeout/i.test(msg) ? `执行超时（${Math.round(timeoutMs / 1000)}s 上限）` : msg });
    }
  })();
});
